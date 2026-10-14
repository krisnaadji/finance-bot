import { expect, it } from 'vitest';
import { normalizeDeliveries } from '../src/intake/normalize';

const at = '2026-10-13T01:00:00Z';
const text = (id: string, body: string) => ({ id, from: 'fixture-sender', type: 'text', text: { body }, timestamp: '1791853200' });
it('retains every supported delivery in provider traversal order', async () => {
  const messages = await normalizeDeliveries('meta', { entry: [
    { changes: [{ value: { messages: [text('m1','one'), { ...text('m2','two'), context: { id: 'receipt' } }] } },
      { value: { messages: [{ ...text('m3','three'), group_id: 'fixture-group' }] } }] },
    { changes: [{ value: { statuses: [{ id: 'status' }], messages: [{ id: 'image', type: 'image' }] } }] },
  ] }, at);
  expect(messages.map(m => [m.messageId,m.text,m.chatId,m.repliedToId])).toEqual([
    ['m1','one','fixture-sender',null],['m2','two','fixture-sender','receipt'],['m3','three','fixture-group',null],
  ]);
});
it('requires stable provider identity rather than inventing a timestamp', async () => {
  await expect(normalizeDeliveries('fonnte', { sender: 'fixture-sender', message: 'makan 10000' },at)).rejects.toThrow('Missing provider identity');
});
it('fingerprints provider fields independently of server retry time', async () => {
  const body = { id: 'f1', sender: 'fixture-sender', message: 'meal', chat_id: 'fixture-group', quoted_id: 'receipt' };
  const [first] = await normalizeDeliveries('fonnte',body,at);
  const [retry] = await normalizeDeliveries('fonnte',body,'2026-10-14T01:00:00Z');
  expect(retry.fingerprint).toBe(first.fingerprint);
  const [changed] = await normalizeDeliveries('fonnte',{...body,message:'changed'},at);
  expect(changed.fingerprint).not.toBe(first.fingerprint);
});
it('records identifiable malformed text as rejected rather than financial input', async () => {
  const [bad] = await normalizeDeliveries('meta',{entry:[{changes:[{value:{messages:[text('bad','x'.repeat(16385))]}}]}]},at);
  expect(bad.rejectionCode).toBe('text_too_large');
  expect(bad.text).toBe('');
});
