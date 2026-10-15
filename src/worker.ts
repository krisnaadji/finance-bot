import { Hono } from 'hono';

import { ingest } from './intake/repository';
import { normalizeDeliveries } from './intake/normalize';
import { processInbox } from './processing/processor';
import { recoverDueWork } from './recovery';
import { logger } from './utils/logger';
import { verifyFonnteToken, verifyMetaSignature } from './utils/webhookAuth';
import { readWebhookBody } from './intake/http';

export type WorkerEnv = {
  BOT_QUEUE: Queue<{ inboxId: string }>;
  SUPABASE_URL?: string; SUPABASE_SERVICE_KEY?: string; GATEWAY?: string;
  WA_VERIFY_TOKEN?: string; WA_APP_SECRET?: string; WA_PHONE_NUMBER_ID?: string; WA_ACCESS_TOKEN?: string;
  FONNTE_TOKEN?: string; FONNTE_WEBHOOK_TOKEN?: string; AI_PROVIDER?: string; AI_API_KEY?: string; AI_MODEL?: string;
  DASHBOARD_URL?: string; LOG_LEVEL?: string; NODE_ENV?: string; DELETE_CONFIRMATIONS_ENABLED?: string;
};
const app = new Hono<{ Bindings: Partial<WorkerEnv> }>();
async function acceptVerifiedBody(body: unknown, env: Partial<WorkerEnv>, selectedGateway: 'meta' | 'fonnte'): Promise<void> {
  const deliveries = await normalizeDeliveries(selectedGateway, body, new Date().toISOString());
  if (!deliveries.length) return;
  const { ids, conflicts } = await ingest(deliveries);
  if (ids.length && !env.BOT_QUEUE) {
    logger.error('webhook', 'queue_binding_missing', undefined, { count: ids.length });
    return;
  }
  for (let start = 0; start < ids.length; start += 100) {
    const messages = ids.slice(start, start + 100).map(inboxId => ({ body: { inboxId } }));
    try { await env.BOT_QUEUE!.sendBatch(messages); }
    catch (error) { logger.error('webhook', 'queue_wake_failed', error, { count: messages.length }); }
  }
}

app.get('/health', (c) => c.json({ ok: true, ts: new Date().toISOString() }));

// Meta webhook verification handshake. Fonnte pings the same path with no
// Meta params and only needs a 200 back.
app.get('/webhook', (c) => {
  const mode = c.req.query('hub.mode');
  const token = c.req.query('hub.verify_token');
  const challenge = c.req.query('hub.challenge');

  // `token &&` is load-bearing: without it, an unset WA_VERIFY_TOKEN and an
  // absent hub.verify_token compare undefined === undefined and the route
  // would echo an attacker-supplied challenge.
  if (mode === 'subscribe' && token && token === (c.env.WA_VERIFY_TOKEN ?? process.env.WA_VERIFY_TOKEN)) {
    return c.text(challenge ?? '');
  }
  return c.body(null, 200);
});

app.post('/webhook', async (c) => {
  const gateway = c.env.GATEWAY ?? process.env.GATEWAY ?? 'meta';

  // Read the body once, as text. Meta signs the original bytes, so nothing may
  // parse and reserialize before verification. Never use c.req.json() here.
  let rawBody: string;
  try {
    rawBody = await readWebhookBody(c.req.raw);
  } catch (error) {
    return c.text('Invalid webhook body', error instanceof Error && error.message === 'webhook_body_too_large' ? 413 : 400);
  }

  if (gateway === 'fonnte') {
    const expected = c.env.FONNTE_WEBHOOK_TOKEN ?? process.env.FONNTE_WEBHOOK_TOKEN;
    if (!expected) {
      logger.error('webhook', 'misconfigured_no_fonnte_token');
      return c.text('Server misconfigured', 500);
    }
    if (!verifyFonnteToken(c.req.raw.headers, expected)) {
      logger.warn('webhook', 'fonnte_token_mismatch');
      return c.text('Unauthorized', 401);
    }
  } else {
    const appSecret = c.env.WA_APP_SECRET ?? process.env.WA_APP_SECRET;
    if (!appSecret) {
      logger.error('webhook', 'misconfigured_no_app_secret');
      return c.text('Server misconfigured', 500);
    }
    const signature = c.req.header('x-hub-signature-256');
    if (!verifyMetaSignature(rawBody, signature, appSecret)) {
      logger.warn('webhook', 'meta_signature_mismatch');
      return c.text('Unauthorized', 401);
    }
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    // The signature checked out, so this really came from the gateway. A 500
    // here would make Meta retry the same broken payload indefinitely.
    logger.warn('webhook', 'invalid_json_body');
    return c.body(null, 200);
  }

  try { await acceptVerifiedBody(body, c.env, gateway as 'meta' | 'fonnte'); }
  catch (error) {
    logger.error('webhook', 'intake_persistence_failed', error, { gateway });
    return c.text('Temporary intake failure', 503);
  }
  return c.body(null, 200);
});

export const fetch = app.fetch.bind(app);
export async function queue(batch: MessageBatch<{ inboxId: string }>): Promise<void> {
  await Promise.all(batch.messages.map(async message => {
    try {
      if (!message.body || typeof message.body.inboxId !== 'string') throw new Error('invalid_queue_message');
      await processInbox(message.body.inboxId);
      message.ack();
    } catch (error) {
      logger.error('queue', 'inbox_processing_failed', error);
      message.retry();
    }
  }));
}
export function scheduled(_controller: ScheduledController, env: WorkerEnv, ctx: ExecutionContext): void {
  ctx.waitUntil(recoverDueWork(env).catch(error => logger.error('scheduler', 'recovery_failed', error)));
}
export default Object.assign(app, { fetch, queue, scheduled });
