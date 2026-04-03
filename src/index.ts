import * as dotenv from 'dotenv';
dotenv.config(); // must be first — loads env before any other imports

import express from 'express';

import { webhookRouter } from './webhook';

const app = express();
app.use(express.json());
app.use('/webhook', webhookRouter);
app.get('/health', (_, res) =>
  res.json({ ok: true, ts: new Date().toISOString() }),
);

const port = process.env.PORT || 3001;
app.listen(port, () => console.log('Bot backend running on port ' + port));
