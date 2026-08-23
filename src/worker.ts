import { Hono } from 'hono';

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

export default app;
