import { supabase } from '../services/supabase';
import { isRecord, isUuid } from '../utils/financialValidation';
import type { Gateway, InboxClaim } from '../intake/types';
import { decodeCommand } from './types';
import type { PreparedCommand, CommitResult } from './types';

function ids(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(id => !isUuid(id))) throw new Error('Invalid command outcome');
  return value;
}
export function decodeCommitResult(value: unknown): CommitResult {
  if (!isRecord(value) || (value.outcome !== 'committed' && value.outcome !== 'replayed' && value.outcome !== 'rejected') ||
      typeof value.code !== 'string' || !/^[a-z0-9_]+$/.test(value.code) ||
      (value.batchId !== null && !isUuid(value.batchId))) throw new Error('Invalid command outcome');
  return { outcome:value.outcome,code:value.code,batchId:value.batchId,
    transactionIds:ids(value.transactionIds),outboundIds:ids(value.outboundIds) };
}
export async function saveCommand(claim: InboxClaim, command: PreparedCommand): Promise<void> {
  const validated = decodeCommand(command);
  const { data,error } = await supabase.rpc('save_bot_command',{
    p_inbox_id:claim.id,p_fence:claim.fence,p_command:validated,
  });
  if (error) throw new Error('command_persistence_unavailable');
  if (data !== true) throw new Error('inbox_claim_lost');
}
export async function commitCommand(claim: InboxClaim, command: PreparedCommand): Promise<CommitResult> {
  decodeCommand(command);
  const { data,error } = await supabase.rpc('commit_bot_command',{p_inbox_id:claim.id,p_fence:claim.fence});
  if (error) throw new Error('command_commit_unavailable');
  return decodeCommitResult(data);
}
export async function lookupReceipt(accountId: string, gateway: Gateway, messageId: string): Promise<Array<{index:number;transactionId:string|null}>> {
  const { data,error } = await supabase.rpc('lookup_bot_receipt',{
    p_account_id:accountId,p_gateway:gateway,p_message_id:messageId,
  });
  if (error) throw new Error('receipt_lookup_unavailable');
  if (!Array.isArray(data)) throw new Error('Invalid receipt mapping');
  let previous=0;
  return data.map(value => {
    if (!isRecord(value) || typeof value.index !== 'number' || !Number.isInteger(value.index) ||
        value.index <= previous || value.index > 100 ||
        (value.transactionId !== null && !isUuid(value.transactionId))) throw new Error('Invalid receipt mapping');
    previous=value.index;
    return {index:value.index,transactionId:value.transactionId};
  });
}
