import * as dotenv from 'dotenv';
dotenv.config(); // must be first — loads env before any other imports

import express, { Request } from 'express';

import { webhookRouter } from './webhook';

const app = express();

// Capture raw body during JSON parsing so the webhook can verify HMAC
// signatures against the original bytes (Meta signs `x-hub-signature-256`
// over the raw body — parsing + re-serializing won't match).
app.use(
  express.json({
    verify: (req: Request, _res, buf) => {
      (req as Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);

app.use('/webhook', webhookRouter);
app.get('/health', (_, res) =>
  res.json({ ok: true, ts: new Date().toISOString() }),
);

const port = process.env.PORT || 3001;
app.listen(port, () => console.log('Bot backend running on port ' + port));
