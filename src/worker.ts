import { Hono } from 'hono';

import { IncomingMessage } from './ai/types';
import { routeMessage } from './router';
import { logger, safeSummarizeMsg } from './utils/logger';
import { verifyFonnteToken, verifyMetaSignature } from './utils/webhookAuth';

const app = new Hono();

// ── Fonnte webhook handler ───────────────────────────────────────────
async function handleFonnteWebhook(body: any) {
  // Fonnte payload: { sender, message, chat_id, id, quoted_id, ... }
  if (!body.message || !body.sender) return;

  // Determine chatId: group messages have chat_id different from sender
  const isGroup = body.chat_id && body.chat_id !== body.sender;
  const chatId = isGroup ? body.chat_id : body.sender;

  const msg: IncomingMessage = {
    messageId: body.id ?? Date.now().toString(),
    chatId,
    text: body.message,
    repliedToId: body.quoted_id ?? null,
    rawFrom: body.sender,
  };

  logger.debug('webhook', 'fonnte_received', safeSummarizeMsg(msg));
  await routeMessage(msg);
}

// ── Meta webhook handler ─────────────────────────────────────────────
async function handleMetaWebhook(body: any) {
  const entry = body?.entry?.[0];
  const changes = entry?.changes?.[0];
  const value = changes?.value;
  const waMsg = value?.messages?.[0];

  if (!waMsg || waMsg.type !== 'text') return;

  const isGroup = value?.metadata?.message_type === 'group' || !!waMsg.group_id;
  const chatId = isGroup ? (waMsg.group_id ?? waMsg.from) : waMsg.from;

  const msg: IncomingMessage = {
    messageId: waMsg.id,
    chatId,
    text: waMsg.text.body,
    repliedToId: waMsg.context?.id ?? null,
    rawFrom: waMsg.from,
  };

  logger.debug('webhook', 'meta_received', safeSummarizeMsg(msg));
  await routeMessage(msg);
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
  if (mode === 'subscribe' && token && token === process.env.WA_VERIFY_TOKEN) {
    return c.text(challenge ?? '');
  }
  return c.body(null, 200);
});

app.post('/webhook', async (c) => {
  const gateway = process.env.GATEWAY ?? 'meta';

  // Read the body once, as text. Meta signs the original bytes, so nothing may
  // parse and reserialize before verification. Never use c.req.json() here.
  const rawBody = await c.req.text();

  if (gateway === 'fonnte') {
    const expected = process.env.FONNTE_WEBHOOK_TOKEN;
    if (!expected) {
      logger.error('webhook', 'misconfigured_no_fonnte_token');
      return c.text('Server misconfigured', 500);
    }
    if (!verifyFonnteToken(c.req.raw.headers, expected)) {
      logger.warn('webhook', 'fonnte_token_mismatch');
      return c.text('Unauthorized', 401);
    }
  } else {
    const appSecret = process.env.WA_APP_SECRET;
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

  // Signature valid: ACK now, process after the response is sent. On Workers
  // the isolate can be torn down as soon as the response returns, which would
  // kill the AI call mid-flight — waitUntil keeps it alive until settled.
  // The .catch is load-bearing: an unhandled rejection here is invisible.
  c.executionCtx.waitUntil(
    (gateway === 'fonnte'
      ? handleFonnteWebhook(body)
      : handleMetaWebhook(body)
    ).catch((err) =>
      logger.error('webhook', 'processing_error', err, { gateway }),
    ),
  );

  return c.body(null, 200);
});

export default app;
