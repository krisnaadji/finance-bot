/**
 * HTTP + auth boundary tests for the Worker.
 *
 * Hono apps are callable in-process via `app.request(input, init, env, ctx)`,
 * so these tests need no network and no wrangler.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import app from '../src/worker';

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
});
