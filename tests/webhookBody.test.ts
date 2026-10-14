import { expect, it } from 'vitest';
import { readWebhookBody } from '../src/intake/http';

it('preserves original Unicode bytes for signature verification', async () => {
  const raw = '{"message":"kopi ☕"}';
  expect(await readWebhookBody(new Request('http://127.0.0.1/webhook',{method:'POST',body:raw}))).toBe(raw);
});
it('preserves a signed UTF-8 byte-order mark', async () => {
  const raw = '\ufeff{"message":"kopi"}';
  expect(await readWebhookBody(new Request('http://127.0.0.1/webhook',{method:'POST',body:raw}))).toBe(raw);
});
it('refuses an oversized webhook even without a Content-Length header', async () => {
  const req = new Request('http://127.0.0.1/webhook',{method:'POST',body:'x'.repeat(1024*1024+1)});
  await expect(readWebhookBody(req)).rejects.toThrow('webhook_body_too_large');
});
it('refuses invalid UTF-8 instead of authenticating replacement characters', async () => {
  const req = new Request('http://127.0.0.1/webhook',{method:'POST',body:new Uint8Array([0xff])});
  await expect(readWebhookBody(req)).rejects.toThrow();
});
