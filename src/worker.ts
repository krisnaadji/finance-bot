import { Hono } from 'hono';

import { logger } from './utils/logger';
import { verifyFonnteToken, verifyMetaSignature } from './utils/webhookAuth';

const app = new Hono();

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

  return c.body(null, 200);
});

export default app;
