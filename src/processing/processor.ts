import { supabase } from '../services/supabase';
import { claimInbox, failInbox, renewInbox } from '../intake/repository';
import type { InboxClaim } from '../intake/types';
import { dispatchOutbound } from '../delivery/dispatch';
import { commitCommand, decodeCommitResult, saveCommand } from './commit';
import { prepareMessage } from './prepare';
import type { CommitResult } from './types';

const HEARTBEAT_INTERVAL_MS = 15_000;
type InboxHeartbeat = { assertHealthy(): void; stop(): Promise<void> };

async function storedOutcome(id: string): Promise<CommitResult | null> {
  const { data, error } = await supabase.from('bot_inbox').select('outcome').eq('id', id).maybeSingle();
  if (error) throw new Error('inbox_outcome_unavailable');
  if (!data || data.outcome === null) return null;
  return decodeCommitResult(data.outcome);
}

function heartbeat(claim: InboxClaim): { assertHealthy(): void; stop(): Promise<void> } {
  let failure: unknown;
  let running: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (running || failure) return;
    running = (async () => {
      try {
        if (!await renewInbox(claim)) failure = new Error('inbox_claim_lost');
      } catch (error) {
        failure = error;
      } finally {
        running = null;
      }
    })();
  }, HEARTBEAT_INTERVAL_MS);

  return {
    assertHealthy() {
      if (failure) throw failure;
    },
    async stop() {
      clearInterval(timer);
      if (running) await running;
      if (failure) throw failure;
    },
  };
}

async function renewBeforeWrite(claim: InboxClaim, beat: InboxHeartbeat): Promise<void> {
  beat.assertHealthy();
  if (!await renewInbox(claim)) throw new Error('inbox_claim_lost');
  beat.assertHealthy();
}


async function dispatchOutbounds(ids: string[]): Promise<void> {
  for (const id of ids) await dispatchOutbound(id);
}

async function persistFailureOrReplay(claim: InboxClaim, error: unknown): Promise<void> {
  let recorded: CommitResult | null;
  try {
    recorded = await storedOutcome(claim.id);
  } catch {
    await failInbox(claim, 'processing_unavailable', true);
    throw error;
  }
  if (recorded) {
    await dispatchOutbounds(recorded.outboundIds);
    return;
  }
  await failInbox(claim, 'processing_unavailable', true);
  throw error;
}

export async function processInbox(id: string): Promise<void> {
  const prior = await storedOutcome(id);
  if (prior) {
    await dispatchOutbounds(prior.outboundIds);
    return;
  }

  const claim = await claimInbox(id);
  if (!claim) return;

  const beat = heartbeat(claim);
  let result: CommitResult | null = null;
  let failed = false;
  let failure: unknown;
  try {
    const command = await prepareMessage(claim);
    beat.assertHealthy();
    if (claim.command === null) {
      await renewBeforeWrite(claim, beat);
      await saveCommand(claim, command);
    }
    await renewBeforeWrite(claim, beat);
    result = await commitCommand(claim, command);
  } catch (error) {
    failure = error;
    failed = true;
  } finally {
    try {
      await beat.stop();
    } catch (error) {
      if (!failed) {
        failure = error;
        failed = true;
      }
    }
  }

  if (failed) {
    await persistFailureOrReplay(claim, failure);
    return;
  }
  if (result === null) throw new Error('command_outcome_unavailable');
  await dispatchOutbounds(result.outboundIds);
}
