/**
 * HTTP + auth boundary tests for the Worker.
 *
 * Hono apps are callable in-process via `app.request(input, init, env, ctx)`,
 * so these tests need no network and no wrangler.
 */
import crypto from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ ingest: vi.fn(), processInbox: vi.fn(), recoverDueWork: vi.fn(), sendBatch: vi.fn() }));
vi.mock('../src/intake/repository', () => ({ ingest: mocks.ingest }));
vi.mock('../src/processing/processor', () => ({ processInbox: mocks.processInbox }));
vi.mock('../src/recovery', () => ({ recoverDueWork: mocks.recoverDueWork }));

import app, { queue, scheduled, type WorkerEnv } from '../src/worker';
/**
 * Fake ExecutionContext. Collects everything passed to waitUntil so tests can
 * await background work deterministically instead of racing it.
 */
function createCtx() {
  const scheduled: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      scheduled.push(p);
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  return { ctx, settled: () => Promise.all(scheduled) };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  mocks.ingest.mockReset().mockResolvedValue({ ids: [], conflicts: [] });
  mocks.processInbox.mockReset();
  mocks.recoverDueWork.mockReset().mockResolvedValue(undefined);
  mocks.sendBatch.mockReset().mockResolvedValue(undefined);
});

describe('GET /health', () => {
  it('returns ok with a timestamp', async () => {
    const { ctx } = createCtx();
    const res = await app.request('/health', {}, {}, ctx);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; ts: string };
    expect(body.ok).toBe(true);
    expect(Number.isNaN(Date.parse(body.ts))).toBe(false);
  });
});

describe('GET /webhook', () => {
  it('echoes the challenge when mode and verify token match', async () => {
    vi.stubEnv('WA_VERIFY_TOKEN', 'verify-me');
    const { ctx } = createCtx();

    const res = await app.request(
      '/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=1158201444',
      {},
      {},
      ctx,
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('1158201444');
  });

  it('returns 200 without the challenge when the token is wrong', async () => {
    vi.stubEnv('WA_VERIFY_TOKEN', 'verify-me');
    const { ctx } = createCtx();

    const res = await app.request(
      '/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1158201444',
      {},
      {},
      ctx,
    );

    // Fonnte pings this path with no Meta params and only needs a 200, so a
    // bad token is not an error here — it just must not echo the challenge.
    expect(res.status).toBe(200);
    expect(await res.text()).not.toBe('1158201444');
  });

  it('does not echo the challenge when WA_VERIFY_TOKEN is unset', async () => {
    // Deliberately no vi.stubEnv here. With both the env var and the query
    // parameter absent, a bare === comparison comes out true.
    const { ctx } = createCtx();

    const res = await app.request(
      '/webhook?hub.mode=subscribe&hub.challenge=attacker-payload',
      {},
      {},
      ctx,
    );

    expect(res.status).toBe(200);
    expect(await res.text()).not.toBe('attacker-payload');
  });
});

const APP_SECRET = 'test-app-secret';

const META_BODY = JSON.stringify({
  entry: [
    {
      changes: [
        {
          value: {
            metadata: {},
            messages: [
              {
                id: 'wamid.TEST1',
                from: '628123456789',
                type: 'text',
                text: { body: 'makan siang 35k' },
              },
            ],
          },
        },
      ],
    },
  ],
});

function sign(body: string, secret: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function postMeta(body: string, signature?: string) {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(signature ? { 'x-hub-signature-256': signature } : {}),
    },
    body,
  };
}

describe('POST /webhook — meta auth', () => {
  it('accepts a genuine signature', async () => {
    vi.stubEnv('GATEWAY', 'meta');
    vi.stubEnv('WA_APP_SECRET', APP_SECRET);
    const { ctx } = createCtx();

    const res = await app.request(
      '/webhook',
      postMeta(META_BODY, sign(META_BODY, APP_SECRET)),
      {},
      ctx,
    );

    expect(res.status).toBe(200);
  });

  it('rejects a forged signature with 401', async () => {
    vi.stubEnv('GATEWAY', 'meta');
    vi.stubEnv('WA_APP_SECRET', APP_SECRET);
    const { ctx } = createCtx();

    const res = await app.request(
      '/webhook',
      postMeta(META_BODY, sign(META_BODY, 'attacker-secret')),
      {},
      ctx,
    );

    expect(res.status).toBe(401);
  });

  it('rejects a missing signature header with 401', async () => {
    vi.stubEnv('GATEWAY', 'meta');
    vi.stubEnv('WA_APP_SECRET', APP_SECRET);
    const { ctx } = createCtx();

    const res = await app.request('/webhook', postMeta(META_BODY), {}, ctx);

    expect(res.status).toBe(401);
  });

  it('fails closed with 500 when WA_APP_SECRET is unset', async () => {
    vi.stubEnv('GATEWAY', 'meta');
    vi.stubEnv('WA_APP_SECRET', '');
    const { ctx } = createCtx();

    const res = await app.request(
      '/webhook',
      postMeta(META_BODY, sign(META_BODY, APP_SECRET)),
      {},
      ctx,
    );

    expect(res.status).toBe(500);
  });
});

describe('POST /webhook — fonnte auth', () => {
  const FONNTE_BODY = JSON.stringify({
    id: 'f-1',
    sender: '628123456789',
    message: 'makan siang 35k',
  });

  function postFonnte(token?: string) {
    return {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { 'x-fonnte-token': token } : {}),
      },
      body: FONNTE_BODY,
    };
  }

  it('accepts a matching token', async () => {
    vi.stubEnv('GATEWAY', 'fonnte');
    vi.stubEnv('FONNTE_WEBHOOK_TOKEN', 'fonnte-secret');
    const { ctx } = createCtx();

    const res = await app.request('/webhook', postFonnte('fonnte-secret'), {}, ctx);

    expect(res.status).toBe(200);
  });

  it('rejects a mismatched token with 401', async () => {
    vi.stubEnv('GATEWAY', 'fonnte');
    vi.stubEnv('FONNTE_WEBHOOK_TOKEN', 'fonnte-secret');
    const { ctx } = createCtx();

    const res = await app.request('/webhook', postFonnte('wrong-secret!!'), {}, ctx);

    expect(res.status).toBe(401);
  });

  it('fails closed with 500 when FONNTE_WEBHOOK_TOKEN is unset', async () => {
    vi.stubEnv('GATEWAY', 'fonnte');
    vi.stubEnv('FONNTE_WEBHOOK_TOKEN', '');
    const { ctx } = createCtx();

    const res = await app.request('/webhook', postFonnte('anything'), {}, ctx);

    expect(res.status).toBe(500);
  });
});

describe('POST /webhook — durable intake', () => {
  const env = () => ({ BOT_QUEUE: { sendBatch: mocks.sendBatch } });
  it('persists verified provider messages before acknowledging and waking inbox IDs', async () => {
    vi.stubEnv('GATEWAY', 'meta');
    vi.stubEnv('WA_APP_SECRET', APP_SECRET);
    mocks.ingest.mockResolvedValue({ ids: ['inbox-1'], conflicts: [] });
    const { ctx } = createCtx();

    const res = await app.request('/webhook', postMeta(META_BODY, sign(META_BODY, APP_SECRET)), env(), ctx);

    expect(res.status).toBe(200);
    expect(mocks.ingest).toHaveBeenCalledOnce();
    expect(mocks.ingest.mock.calls[0][0]).toMatchObject([{
      gateway: 'meta', messageId: 'wamid.TEST1', chatId: '628123456789',
      rawFrom: '628123456789', text: 'makan siang 35k', repliedToId: null,
    }]);
    expect(mocks.sendBatch).toHaveBeenCalledExactlyOnceWith([{ body: { inboxId: 'inbox-1' } }]);
  });

  it('returns a retryable response when persistence fails', async () => {
    vi.stubEnv('GATEWAY', 'meta');
    vi.stubEnv('WA_APP_SECRET', APP_SECRET);
    mocks.ingest.mockRejectedValueOnce(new Error('database unavailable'));
    const { ctx } = createCtx();

    const res = await app.request('/webhook', postMeta(META_BODY, sign(META_BODY, APP_SECRET)), env(), ctx);

    expect(res.status).toBe(503);
    expect(mocks.sendBatch).not.toHaveBeenCalled();
  });

  it('keeps the durable intake acknowledged when the queue wake fails', async () => {
    vi.stubEnv('GATEWAY', 'meta');
    vi.stubEnv('WA_APP_SECRET', APP_SECRET);
    mocks.ingest.mockResolvedValue({ ids: ['inbox-1'], conflicts: [] });
    mocks.sendBatch.mockRejectedValueOnce(new Error('queue unavailable'));
    const { ctx } = createCtx();

    const res = await app.request('/webhook', postMeta(META_BODY, sign(META_BODY, APP_SECRET)), env(), ctx);

    expect(res.status).toBe(200);
    expect(mocks.ingest).toHaveBeenCalledOnce();
    expect(mocks.sendBatch).toHaveBeenCalledOnce();
  });

  it('ignores non-text messages and malformed verified bodies', async () => {
    vi.stubEnv('GATEWAY', 'meta');
    vi.stubEnv('WA_APP_SECRET', APP_SECRET);
    const image = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id: 'w1', from: '6281', type: 'image' }] } }] }] });
    const { ctx } = createCtx();
    const imageResponse = await app.request('/webhook', postMeta(image, sign(image, APP_SECRET)), env(), ctx);
    const malformed = 'not json';
    const malformedResponse = await app.request('/webhook', postMeta(malformed, sign(malformed, APP_SECRET)), env(), ctx);
    expect(imageResponse.status).toBe(200);
    expect(malformedResponse.status).toBe(200);
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it('persists and wakes a verified Fonnte message', async () => {
    vi.stubEnv('GATEWAY', 'fonnte');
    vi.stubEnv('FONNTE_WEBHOOK_TOKEN', 'fonnte-secret');
    mocks.ingest.mockResolvedValue({ ids: ['inbox-f'], conflicts: [] });
    const { ctx } = createCtx();
    const res = await app.request('/webhook', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-fonnte-token': 'fonnte-secret' },
      body: JSON.stringify({ id: 'f-1', sender: '628123456789', message: 'makan siang 35k' }),
    }, env(), ctx);
    expect(res.status).toBe(200);
    expect(mocks.ingest.mock.calls[0][0]).toMatchObject([{ gateway: 'fonnte', messageId: 'f-1' }]);
    expect(mocks.sendBatch).toHaveBeenCalledExactlyOnceWith([{ body: { inboxId: 'inbox-f' } }]);
  });
});

describe('queue and scheduled handlers', () => {
  it('acks durable outcomes and retries failed processing per message', async () => {
    mocks.processInbox.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('temporary failure'));
    const observed: string[] = [];
    const messages = ['inbox-ok', 'inbox-retry'].map(inboxId => ({
      body: { inboxId },
      ack: () => observed.push(`ack:${inboxId}`),
      retry: () => observed.push(`retry:${inboxId}`),
    }));
    await queue({ messages } as unknown as MessageBatch<{ inboxId: string }>);
    expect(mocks.processInbox.mock.calls.map(([id]) => id)).toEqual(['inbox-ok', 'inbox-retry']);
    expect(observed.sort()).toEqual(['ack:inbox-ok', 'retry:inbox-retry']);
  });

  it('runs bounded recovery from the scheduled entry point', async () => {
    const { ctx, settled } = createCtx();
    const env = { BOT_QUEUE: { sendBatch: mocks.sendBatch, send: vi.fn() } };
    scheduled({} as ScheduledController, env as unknown as WorkerEnv, ctx);
    await settled();
    expect(mocks.recoverDueWork).toHaveBeenCalledOnce();
    expect(mocks.recoverDueWork).toHaveBeenCalledWith(env);
  });
});
