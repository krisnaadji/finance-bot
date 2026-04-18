import { Router, Request, Response } from 'express';

import { routeMessage } from './router';
import { IncomingMessage } from './ai/types';
import { verifyMetaSignature, verifyFonnteToken } from './utils/webhookAuth';

export const webhookRouter = Router();

// GET: Meta webhook verification (also used for Fonnte — just return 200)
webhookRouter.get('/', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.WA_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(200); // Fonnte just needs a 200
  }
});

// POST: incoming messages — verify signature BEFORE ACK so forged requests
// get 401 (and Meta/Fonnte surfaces this in their dashboards). Only after
// a successful verification do we ACK 200 and process async.
webhookRouter.post('/', async (req: Request, res: Response) => {
  const gateway = process.env.GATEWAY ?? 'meta';

  if (gateway === 'fonnte') {
    const expected = process.env.FONNTE_WEBHOOK_TOKEN;
    if (!expected) {
      console.error('[webhook] FONNTE_WEBHOOK_TOKEN not set — rejecting all requests');
      return res.status(500).send('Server misconfigured');
    }
    if (!verifyFonnteToken(req, expected)) {
      console.warn('[webhook] Fonnte token mismatch — rejecting request');
      return res.status(401).send('Unauthorized');
    }
  } else {
    const appSecret = process.env.WA_APP_SECRET;
    if (!appSecret) {
      console.error('[webhook] WA_APP_SECRET not set — rejecting all requests');
      return res.status(500).send('Server misconfigured');
    }
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    const signature = req.get('x-hub-signature-256');
    if (!verifyMetaSignature(rawBody, signature, appSecret)) {
      console.warn('[webhook] Meta signature mismatch — rejecting request');
      return res.status(401).send('Unauthorized');
    }
  }

  // Signature valid: ACK immediately, then process async (Meta expects <5s).
  res.sendStatus(200);
  try {
    if (gateway === 'fonnte') {
      await handleFonnteWebhook(req.body);
    } else {
      await handleMetaWebhook(req.body);
    }
  } catch (err) {
    console.error('Webhook processing error:', err);
  }
});

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

  console.log('Fonnte webhook hit:', JSON.stringify(msg, null, 2));
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

  console.log('Meta webhook hit:', JSON.stringify(msg, null, 2));
  await routeMessage(msg);
}
