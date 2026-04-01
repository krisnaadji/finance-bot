import { Router, Request, Response } from 'express';
import { routeMessage } from './router';
import { IncomingMessage } from './ai/types';

export const webhookRouter = Router();

// GET: WhatsApp webhook verification handshake
webhookRouter.get('/', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.WA_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// POST: incoming messages from WhatsApp
webhookRouter.post('/', async (req: Request, res: Response) => {
  console.log('Webhook hit:', JSON.stringify(req.body, null, 2));
  res.sendStatus(200); // Always ACK immediately — WhatsApp retries if no 200
  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const waMsg = value?.messages?.[0];

    if (!waMsg || waMsg.type !== 'text') return; // ignore non-text

    // chatId: for DMs = sender phone. For groups = group chat ID.
    // WhatsApp group messages have a different metadata structure.
    const isGroup =
      value?.metadata?.message_type === 'group' || !!waMsg.group_id;
    const chatId = isGroup ? (waMsg.group_id ?? waMsg.from) : waMsg.from;

    const msg: IncomingMessage = {
      messageId: waMsg.id,
      chatId,
      text: waMsg.text.body,
      repliedToId: waMsg.context?.id ?? null,
      rawFrom: waMsg.from, // always the individual sender
    };

    await routeMessage(msg);
  } catch (err) {
    console.error('Webhook processing error:', err);
  }
});
