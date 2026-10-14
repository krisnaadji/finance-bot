import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  outcome: null as unknown,
  outboundRow: { text: 'frozen fixture reply' as string | null, reply_payload: {} as unknown },
  claim: vi.fn(),
  renew: vi.fn(),
  fail: vi.fn(),
  prepare: vi.fn(),
  save: vi.fn(),
  commit: vi.fn(),
  claimOutbound: vi.fn(),
  freeze: vi.fn(),
  dispatch: vi.fn(),
  render: vi.fn(),
}));

vi.mock('../src/services/supabase', () => ({
  supabase: {
    from: state.from,
    rpc: state.rpc,
  },
}));
vi.mock('../src/intake/repository', () => ({
  claimInbox: state.claim,
  renewInbox: state.renew,
  failInbox: state.fail,
}));
vi.mock('../src/processing/prepare', () => ({ prepareMessage: state.prepare }));
vi.mock('../src/processing/commit', () => ({
  saveCommand: state.save, commitCommand: state.commit, decodeCommitResult: (value: unknown) => value,
}));
vi.mock('../src/delivery/repository', () => ({ claimOutbound: state.claimOutbound, freezeReply: state.freeze }));
vi.mock('../src/delivery/dispatch', () => ({ dispatchClaim: state.dispatch }));
vi.mock('../src/delivery/render', () => ({ renderReply: state.render }));

import { processInbox } from '../src/processing/processor';
import { recoverDueWork } from '../src/recovery';
import type { InboxClaim } from '../src/intake/types';
import type { OutboundClaim } from '../src/delivery/types';

const inboxId = '123e4567-e89b-42d3-a456-426614174000';
const outboundId = '123e4567-e89b-42d3-a456-426614174001';
const claim: InboxClaim = {
  id: inboxId,
  fence: '1',
  attempt: 1,
  leaseUntil: '2026-10-13T01:01:00.000Z',
  delivery: {
    gateway: 'meta', messageId: 'fixture-message', chatId: 'fixture-chat', rawFrom: 'fixture-sender',
    text: 'meal 10000', repliedToId: null, receivedAt: '2026-10-13T01:00:00.000Z', providerAt: null,
    fingerprint: 'a'.repeat(64),
  },
  command: null,
};
const outboundClaim = { id: outboundId, text: 'frozen fixture reply' } as OutboundClaim;
const committed = {
  outcome: 'committed' as const, code: 'created', batchId: null,
  transactionIds: [], outboundIds: [outboundId],
};

beforeEach(() => {
  vi.clearAllMocks();
  state.outcome = null;
  state.outboundRow = { text: 'frozen fixture reply', reply_payload: {} };
  state.from.mockImplementation((table: string) => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({
          data: table === 'bot_inbox' ? (state.outcome === null ? { outcome: null } : { outcome: state.outcome }) : state.outboundRow,
          error: null,
        }),
      }),
    }),
  }));
  state.claim.mockResolvedValue(claim);
  state.renew.mockResolvedValue(true);
  state.fail.mockResolvedValue(undefined);
  state.prepare.mockResolvedValue({ kind: 'reply', accountId: null, reply: { kind: 'ordinary', text: 'fixture' } });
  state.save.mockResolvedValue(undefined);
  state.commit.mockResolvedValue(committed);
  state.claimOutbound.mockResolvedValue(outboundClaim);
  state.freeze.mockResolvedValue('frozen fixture reply');
  state.dispatch.mockResolvedValue(undefined);
  state.render.mockReturnValue('rendered fixture reply');
  state.rpc.mockResolvedValue({ data: { inboxIds: [], outboundIds: [] }, error: null });
});

it('replays a stored outcome without claiming or committing the inbox again', async () => {
  state.outcome = committed;
  state.claimOutbound.mockResolvedValue(null);

  await processInbox(inboxId);

  expect(state.claim).not.toHaveBeenCalled();
  expect(state.prepare).not.toHaveBeenCalled();
  expect(state.commit).not.toHaveBeenCalled();
  expect(state.claimOutbound).toHaveBeenCalledWith(outboundId);
  expect(state.dispatch).not.toHaveBeenCalled();
});

it('persists a retryable failure instead of treating preparation failure as completion', async () => {
  state.prepare.mockRejectedValue(new Error('dependency_unavailable'));

  await expect(processInbox(inboxId)).rejects.toThrow('dependency_unavailable');

  expect(state.fail).toHaveBeenCalledWith(claim, 'processing_unavailable', true);
  expect(state.commit).not.toHaveBeenCalled();
  expect(state.claimOutbound).not.toHaveBeenCalled();
});
it('dispatches a committed business rejection without scheduling an inbox retry', async () => {
  state.commit.mockResolvedValue({
    outcome: 'rejected', code: 'invalid', batchId: null, transactionIds: [], outboundIds: [outboundId],
  });

  await processInbox(inboxId);

  expect(state.fail).not.toHaveBeenCalled();
  expect(state.claimOutbound).toHaveBeenCalledWith(outboundId);
  expect(state.dispatch).toHaveBeenCalledWith(outboundClaim);
});

it('freezes and dispatches only database-selected due outbound work', async () => {
  const queueSend = vi.fn().mockResolvedValue(undefined);
  state.rpc.mockResolvedValue({ data: { inboxIds: [inboxId], outboundIds: [outboundId] }, error: null });
  state.outboundRow = { text: null, reply_payload: {
    language: 'en', kind: 'ordinary', code: 'reply', text: 'fixture', rows: [],
    categoryName: null, categoryType: null, accountName: null,
  } };

  await recoverDueWork({ BOT_QUEUE: { send: queueSend } } as never);

  expect(state.rpc).toHaveBeenCalledWith('claim_bot_recovery_work', {
    p_inbox_limit: 50, p_outbound_limit: 50, p_wake_delay_seconds: 60,
  });
  expect(queueSend).toHaveBeenCalledTimes(1);
  expect(queueSend).toHaveBeenCalledWith({ inboxId });
  expect(state.render).toHaveBeenCalledWith({
    language: 'en', kind: 'ordinary', code: 'reply', text: 'fixture', rows: [],
    categoryName: null, categoryType: null, accountName: null,
  });
  expect(state.freeze).toHaveBeenCalledWith(outboundId, 'rendered fixture reply');
  expect(state.claimOutbound).toHaveBeenCalledWith(outboundId);
  expect(state.dispatch).toHaveBeenCalledWith(outboundClaim);
});
it('cleans expired export snapshots during scheduled recovery', async () => {
  state.rpc.mockImplementation(async (name: string) => ({ data: { inboxIds: [], outboundIds: [] }, error: null }));
  await recoverDueWork({ BOT_QUEUE: { send: vi.fn() } } as never);
  expect(state.rpc).toHaveBeenCalledWith('cleanup_expired_finance_exports', { p_limit: 1000 });
});

it('continues inbox and outbound recovery when export cleanup is unavailable', async () => {
  const queueSend = vi.fn();
  state.rpc.mockImplementation(async (name: string) => name === 'cleanup_expired_finance_exports'
    ? { data: null, error: { code: '08006' } }
    : { data: { inboxIds: [inboxId], outboundIds: [] }, error: null });
  await expect(recoverDueWork({ BOT_QUEUE: { send: queueSend } } as never)).resolves.toBeUndefined();
  expect(queueSend).toHaveBeenCalledWith({ inboxId });
});

it('rejects a recovery response larger than its bounded batch before enqueuing', async () => {
  const queueSend = vi.fn();
  state.rpc.mockResolvedValue({
    data: { inboxIds: Array.from({ length: 51 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`), outboundIds: [] },
    error: null,
  });

  await expect(recoverDueWork({ BOT_QUEUE: { send: queueSend } } as never)).rejects.toThrow();
  expect(queueSend).not.toHaveBeenCalled();
});
