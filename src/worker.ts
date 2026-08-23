import { Hono } from 'hono';

const app = new Hono();

app.get('/health', (c) => c.json({ ok: true, ts: new Date().toISOString() }));

// Meta webhook verification handshake. Fonnte pings the same path with no
// Meta params and only needs a 200 back.
app.get('/webhook', (c) => {
  const mode = c.req.query('hub.mode');
  const token = c.req.query('hub.verify_token');
  const challenge = c.req.query('hub.challenge');

  if (mode === 'subscribe' && token === process.env.WA_VERIFY_TOKEN) {
    return c.text(challenge ?? '');
  }
  return c.body(null, 200);
});

export default app;
