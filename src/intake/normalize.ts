import type { Delivery, Gateway } from './types';

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
function list(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Invalid provider collection');
  return value;
}
function identity(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) throw new Error('Missing provider identity');
  return value;
}
function eventTime(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^\d{1,12}$/.test(value)) return null;
  const date = new Date(Number(value) * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

async function delivery(gateway: Gateway, item: Record<string, unknown>, receivedAt: string,
  group: unknown, text: unknown, reply: unknown, sender: unknown, providerTime: unknown): Promise<Delivery> {
  const messageId = identity(item.id);
  const rawFrom = identity(sender);
  const chatId = group === undefined || group === null ? rawFrom : identity(group);
  const repliedToId = reply === undefined || reply === null ? null : identity(reply);
  let rejectionCode: string | undefined;
  if (typeof text !== 'string' || !text.trim()) rejectionCode = 'invalid_text';
  else if (new TextEncoder().encode(text).byteLength > 16 * 1024) rejectionCode = 'text_too_large';
  const providerAt = eventTime(providerTime);
  const fields = JSON.stringify([gateway,messageId,chatId,rawFrom,text ?? null,repliedToId,providerTime ?? null]);
  const hash = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(fields));
  const fingerprint = Array.from(new Uint8Array(hash),b => b.toString(16).padStart(2,'0')).join('');
  return { gateway,messageId,chatId,rawFrom,text: rejectionCode ? '' : text as string,
    repliedToId,receivedAt,providerAt,fingerprint,...(rejectionCode ? { rejectionCode } : {}) };
}

export async function normalizeDeliveries(gateway: Gateway, body: unknown, receivedAt: string): Promise<Delivery[]> {
  if (!Number.isFinite(Date.parse(receivedAt))) throw new Error('Invalid receipt instant');
  const root = record(body);
  if (gateway === 'fonnte') {
    if (root.type !== undefined && root.type !== 'text') return [];
    if (root.message === undefined && root.sender === undefined) return [];
    return [await delivery(gateway,root,receivedAt,root.chat_id,root.message,root.quoted_id,root.sender,root.timestamp)];
  }
  const deliveries: Delivery[] = [];
  for (const entry of list(root.entry)) {
    for (const change of list(record(entry).changes)) {
      const value = record(record(change).value);
      for (const message of list(value.messages)) {
        const item = record(message);
        if (item.type !== 'text') continue;
        const group = item.group_id ?? (record(value.metadata).message_type === 'group' ? item.from : undefined);
        deliveries.push(await delivery(gateway,item,receivedAt,group,record(item.text).body,
          record(item.context).id,item.from,item.timestamp));
      }
    }
  }
  return deliveries;
}
