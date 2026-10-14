import { supabase } from '../services/supabase';
import type { Delivery, InboxClaim, IngestResult } from './types';

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid inbox response');
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('Invalid inbox response');
  return value;
}
function instant(value: unknown): string {
  const result = string(value);
  if (!Number.isFinite(Date.parse(result))) throw new Error('Invalid inbox instant');
  return result;
}
function nullableString(value: unknown): string | null {
  return value === null ? null : string(value);
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('Invalid inbox response');
  return value.map(string);
}
export function decodeClaim(value: unknown): InboxClaim | null {
  if (value === null) return null;
  const row = object(value), d = object(row.delivery);
  if (d.gateway !== 'meta' && d.gateway !== 'fonnte') throw new Error('Invalid inbox gateway');
  if (typeof row.attempt !== 'number' || !Number.isInteger(row.attempt) || row.attempt < 1 || row.attempt > 5 ||
      typeof row.fence !== 'string' || !/^[1-9]\d*$/.test(row.fence)) throw new Error('Invalid inbox claim');
  if (typeof d.text !== 'string' || new TextEncoder().encode(d.text).byteLength > 16384 ||
      typeof d.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(d.fingerprint)) throw new Error('Invalid inbox delivery');
  const delivery: Delivery = { gateway: d.gateway,messageId:string(d.messageId),chatId:string(d.chatId),
    rawFrom:string(d.rawFrom),text:d.text,repliedToId:nullableString(d.repliedToId),
    receivedAt:instant(d.receivedAt),providerAt:d.providerAt === null ? null : instant(d.providerAt),fingerprint:d.fingerprint };
  if (!('command' in row)) throw new Error('Invalid inbox command');
  return { id:string(row.id),fence:row.fence,attempt:row.attempt,leaseUntil:instant(row.leaseUntil),delivery,command:row.command };
}

export async function ingest(deliveries: Delivery[]): Promise<IngestResult> {
  const { data,error } = await supabase.rpc('ingest_bot_messages',{p_deliveries:deliveries});
  if (error) throw new Error('inbox_ingestion_unavailable');
  const result = object(data);
  return { ids:strings(result.ids),conflicts:strings(result.conflicts) };
}
export async function claimInbox(id: string): Promise<InboxClaim | null> {
  const { data,error } = await supabase.rpc('claim_bot_message',{p_inbox_id:id});
  if (error) throw new Error('inbox_claim_unavailable');
  return decodeClaim(data);
}
export async function renewInbox(claim: InboxClaim): Promise<boolean> {
  const { data,error } = await supabase.rpc('renew_bot_claim',{p_inbox_id:claim.id,p_fence:claim.fence});
  if (error || typeof data !== 'boolean') throw new Error('inbox_renewal_unavailable');
  return data;
}
export async function failInbox(claim: InboxClaim, code: string, retryable: boolean): Promise<void> {
  const { data,error } = await supabase.rpc('fail_bot_message',{
    p_inbox_id:claim.id,p_fence:claim.fence,p_code:code,p_retryable:retryable,
  });
  if (error || typeof data !== 'boolean') throw new Error('inbox_failure_persistence_unavailable');
  if (!data) throw new Error('inbox_claim_lost');
}
