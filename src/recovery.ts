import { supabase } from './services/supabase';
import { dispatchOutbound } from './delivery/dispatch';
import { logger } from './utils/logger';
import { isRecord, isUuid } from './utils/financialValidation';
import type { WorkerEnv } from './worker';

const RECOVERY_BATCH_SIZE = 50;
const WAKE_DELAY_SECONDS = 60;

type DueWork = { inboxIds: string[]; outboundIds: string[] };

function ids(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > RECOVERY_BATCH_SIZE || value.some(id => !isUuid(id))) {
    throw new Error('invalid_recovery_work');
  }
  return value;
}

function decodeDueWork(value: unknown): DueWork {
  if (!isRecord(value) || Object.keys(value).some(key => key !== 'inboxIds' && key !== 'outboundIds')) {
    throw new Error('invalid_recovery_work');
  }
  return { inboxIds: ids(value.inboxIds), outboundIds: ids(value.outboundIds) };
}

async function claimDueWork(): Promise<DueWork> {
  const { data, error } = await supabase.rpc('claim_bot_recovery_work', {
    p_inbox_limit: RECOVERY_BATCH_SIZE,
    p_outbound_limit: RECOVERY_BATCH_SIZE,
    p_wake_delay_seconds: WAKE_DELAY_SECONDS,
  });
  if (error) throw new Error('recovery_claim_unavailable');
  return decodeDueWork(data);
}
async function cleanupExpiredExports(): Promise<void> {
  try {
    const { error } = await supabase.rpc('cleanup_expired_finance_exports', { p_limit: 1000 });
    if (error) logger.warn('scheduler', 'export_cleanup_unavailable');
  } catch {
    logger.warn('scheduler', 'export_cleanup_unavailable');
  }
}

async function dispatchOutbounds(ids: string[]): Promise<void> {
  for (const id of ids) await dispatchOutbound(id);
}

export async function recoverDueWork(env: WorkerEnv): Promise<void> {
  const [work] = await Promise.all([claimDueWork(), cleanupExpiredExports()]);
  await Promise.all([
    Promise.all(work.inboxIds.map(inboxId => env.BOT_QUEUE.send({ inboxId }))),
    dispatchOutbounds(work.outboundIds),
  ]);
}
