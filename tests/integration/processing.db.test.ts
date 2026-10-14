import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { localSupabase } from './helpers/localSupabase';
import { applyPhase2MigrationsThrough, closeFixture, seedLinkedFixture, sql } from './helpers/phase2Db';
import type { Fixture } from './helpers/phase2Db';

const state = vi.hoisted(() => ({ ai: vi.fn<(...args: unknown[]) => Promise<unknown>>(), dispatch: vi.fn() }));
vi.mock('../../src/services/supabase', () => ({
  supabase: {
    from: (table: string) => localSupabase.from(table),
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name !== 'claim_bot_recovery_work') return localSupabase.rpc(name, args);
      try {
        const [row] = await sql<{ data: unknown }>(
          'select public.claim_bot_recovery_work($1,$2,$3) as data',
          [args.p_inbox_limit, args.p_outbound_limit, args.p_wake_delay_seconds],
        );
        return { data: row.data, error: null };
      } catch (error) {
        return { data: null, error };
      }
    },
  },
}));
vi.mock('../../src/ai', () => ({ callAI: state.ai }));
vi.mock('../../src/delivery/dispatch', () => ({ dispatchClaim: state.dispatch }));

import { businessDate, shiftCivilDay } from '../../src/utils/businessDate';
import { claimInbox, ingest } from '../../src/intake/repository';
import { commitCommand, saveCommand } from '../../src/processing/commit';
import { processInbox } from '../../src/processing/processor';
import { recoverDueWork } from '../../src/recovery';
import { claimOutbound, freezeReply, settleOutbound } from '../../src/delivery/repository';
import type { OutboundClaim } from '../../src/delivery/types';

beforeAll(() => applyPhase2MigrationsThrough('202610130006_export_snapshots.sql'));
beforeEach(() => vi.clearAllMocks());
afterAll(closeFixture);

function delivery(f: Fixture, text: string, messageId = randomUUID(), chatId = f.chatId) {
  return {
    gateway: 'meta' as const, messageId, chatId, rawFrom: f.requester, text, repliedToId: null,
    receivedAt: '2026-10-12T16:59:59.000Z', providerAt: null, fingerprint: 'd'.repeat(64),
  };
}
async function inbox(f: Fixture, text: string, chatId = f.chatId) {
  const result = await ingest([delivery(f, text, randomUUID(), chatId)]);
  return result.ids[0];
}
async function replyTask(f: Fixture, text: string) {
  const id = await inbox(f, text);
  const claim = (await claimInbox(id))!;
  await saveCommand(claim, { kind: 'reply', accountId: null, reply: { text, kind: 'ordinary' } });
  const result = await commitCommand(claim, { kind: 'reply', accountId: null, reply: { text, kind: 'ordinary' } });
  return { inboxId: id, outboundId: result.outboundIds[0] };
}

it('replays a committed message without another transaction or logical receipt', async () => {
  const f = await seedLinkedFixture();
  state.ai.mockImplementation(async (...args: unknown[]) => {
    const instant = args[5] as Date;
    return {
      action: 'CREATE_TRANSACTION',
      payload: {
        amount: '10000.00', type: 'expense', category: 'Makanan', description: 'dinner',
        date: shiftCivilDay(businessDate(instant), -1),
      },
    };
  });
  state.dispatch.mockImplementation(async (claim: OutboundClaim) => {
    await settleOutbound(claim, { kind: 'accepted', providerMessageId: `fixture-provider-${claim.id}` });
  });
  const message = delivery(f, 'kemarin makan 10000');
  const id = (await ingest([message])).ids[0];

  await processInbox(id);
  await processInbox(id);

  const transactions = await sql<{ date: string; amount: string }>(
    'select date::text,amount::text from public.transactions where wa_user_message_id=$1', [message.messageId],
  );
  const [counts] = await sql<{ batches: string; replies: string }>(`select
    (select count(*)::text from public.bot_batches where inbox_id=$1) as batches,
    (select count(*)::text from public.bot_outbound where inbox_id=$1) as replies`, [id]);
  expect(transactions).toEqual([{ date: '2026-10-11', amount: '10000.00' }]);
  expect(counts).toEqual({ batches: '1', replies: '1' });
  expect(state.ai).toHaveBeenCalledTimes(1);
  expect(state.dispatch).toHaveBeenCalledTimes(1);
});

it('enqueues at most 50 due inboxes and leaves future retries and live leases alone', async () => {
  const f = await seedLinkedFixture();
  const dueDeliveries = Array.from({ length: 51 }, () => delivery(f, 'fixture work', randomUUID(), `fixture-chat-${randomUUID()}`));
  const dueIds = (await ingest(dueDeliveries)).ids;
  const futureId = await inbox(f, 'future retry', `fixture-chat-${randomUUID()}`);
  await sql("update public.bot_inbox set next_attempt_at=clock_timestamp()+interval '10 minutes' where id=$1", [futureId]);
  const activeId = await inbox(f, 'active owner', `fixture-chat-${randomUUID()}`);
  expect(await claimInbox(activeId)).not.toBeNull();
  const queueSend = vi.fn().mockResolvedValue(undefined);
  const env = { BOT_QUEUE: { send: queueSend } } as never;

  await recoverDueWork(env);

  expect(queueSend).toHaveBeenCalledTimes(50);
  const firstBatch = queueSend.mock.calls.map(([body]) => body.inboxId as string);
  expect(firstBatch.every(id => dueIds.includes(id))).toBe(true);
  expect(firstBatch).not.toContain(futureId);
  expect(firstBatch).not.toContain(activeId);
  const [marked] = await sql<{ count: string }>(
    'select count(*)::text as count from public.bot_inbox where id=any($1::uuid[]) and next_wake_at>clock_timestamp()',
    [firstBatch],
  );
  expect(marked.count).toBe('50');

  await recoverDueWork(env);
  expect(queueSend).toHaveBeenCalledTimes(51);
  expect(dueIds).toContain(queueSend.mock.calls[50][0].inboxId);
});

it('freezes and dispatches a due outbox task but holds an expired sending lease as uncertain', async () => {
  const f = await seedLinkedFixture();
  const due = await replyTask(f, 'recover this reply');
  const interrupted = await replyTask(f, 'do not resend this reply');
  await freezeReply(interrupted.outboundId, 'previously frozen reply');
  const sending = (await claimOutbound(interrupted.outboundId))!;
  await sql("update public.bot_outbound set lease_until=clock_timestamp()-interval '1 second' where id=$1", [interrupted.outboundId]);
  const queueSend = vi.fn().mockResolvedValue(undefined);
  state.dispatch.mockImplementation(async (claim: OutboundClaim) => {
    await settleOutbound(claim, { kind: 'accepted', providerMessageId: `fixture-provider-${claim.id}` });
  });

  await recoverDueWork({ BOT_QUEUE: { send: queueSend } } as never);

  expect(queueSend).not.toHaveBeenCalled();
  expect(state.dispatch).toHaveBeenCalledTimes(1);
  expect(state.dispatch.mock.calls[0][0].id).toBe(due.outboundId);
  const [row] = await sql<{ state: string; diagnostic_code: string | null }>(
    'select state,diagnostic_code from public.bot_outbound where id=$1', [interrupted.outboundId],
  );
  expect(row).toEqual({ state: 'uncertain', diagnostic_code: 'interrupted_send' });
  expect(sending.id).toBe(interrupted.outboundId);
});
