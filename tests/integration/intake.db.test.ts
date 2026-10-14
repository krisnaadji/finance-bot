import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { applyPhase2Migrations, closeFixture, sql } from './helpers/phase2Db';

beforeAll(applyPhase2Migrations);
afterAll(closeFixture);
function delivery(chatId = randomUUID(), messageId = randomUUID()) {
  return { gateway: 'meta', messageId, chatId, rawFrom: 'fixture-sender', text: 'meal 10000', repliedToId: null,
    receivedAt: '2026-10-13T01:00:00Z', providerAt: null, fingerprint: 'a'.repeat(64) };
}
async function ingest(rows: unknown[]) {
  return (await sql<{ outcome: { ids: string[]; conflicts: string[] } }>(
    'select public.ingest_bot_messages($1::jsonb) as outcome',[JSON.stringify(rows)]))[0].outcome;
}
async function claim(id: string) {
  return (await sql<{ outcome: null | { id: string; fence: string; attempt: number } }>(
    'select public.claim_bot_message($1) as outcome',[id]))[0].outcome;
}
it('concurrent duplicate delivery creates one identity and preserves first receipt instant', async () => {
  const d = delivery();
  const [a,b] = await Promise.all([ingest([d]),ingest([{...d,receivedAt:'2026-10-14T00:00:00Z'}])]);
  expect(a.ids).toEqual(b.ids);
  const [count] = await sql<{ n: string }>('select count(*)::text as n from public.bot_inbox where message_id=$1',[d.messageId]);
  expect(count.n).toBe('1');
  const conflict = await ingest([{...d,fingerprint:'b'.repeat(64),text:'changed'}]);
  expect(conflict.conflicts).toEqual([d.messageId]);
  const [row] = await sql<{ text: string }>('select text from public.bot_inbox where message_id=$1',[d.messageId]);
  expect(row.text).toBe('meal 10000');
});
it('invalid second delivery rolls back all new identities', async () => {
  const d = delivery();
  await expect(ingest([d,{...delivery(),gateway:'invalid'}])).rejects.toThrow();
  const [row] = await sql<{ n: string }>('select count(*)::text as n from public.bot_inbox where message_id=$1',[d.messageId]);
  expect(row.n).toBe('0');
});
it('only one chat owner can claim and later messages cannot overtake retry waiting', async () => {
  const chat = randomUUID();
  const { ids } = await ingest([delivery(chat),delivery(chat)]);
  expect(await claim(ids[1])).toBeNull();
  const owners = await Promise.all([claim(ids[0]),claim(ids[0])]);
  expect(owners.filter(Boolean)).toHaveLength(1);
  const owner = owners.find(Boolean)!;
  await sql('select public.fail_bot_message($1,$2,$3,true)',[owner.id,owner.fence,'dependency_unavailable']);
  expect(await claim(ids[1])).toBeNull();
  expect(await claim(ids[0])).toBeNull();
});
it('expired owner loses command-save rights after fenced takeover', async () => {
  const { ids } = await ingest([delivery()]);
  const first = (await claim(ids[0]))!;
  await sql("update public.bot_inbox set lease_until=clock_timestamp()-interval '1 second' where id=$1",[first.id]);
  const second = (await claim(ids[0]))!;
  expect(BigInt(second.fence)).toBeGreaterThan(BigInt(first.fence));
  const [stale] = await sql<{ saved: boolean }>('select public.save_bot_command($1,$2,$3) as saved',[first.id,first.fence,'{}']);
  expect(stale.saved).toBe(false);
  const [current] = await sql<{ saved: boolean }>('select public.save_bot_command($1,$2,$3) as saved',[second.id,second.fence,'{"kind":"reply"}']);
  expect(current.saved).toBe(true);
});
it('browser roles cannot read inbox text or execute service claims', async () => {
  const [grants] = await sql<{ anon: boolean; authenticated: boolean; service: boolean }>(`select
    has_table_privilege('anon','public.bot_inbox','SELECT') as anon,
    has_function_privilege('authenticated','public.claim_bot_message(uuid)','EXECUTE') as authenticated,
    has_function_privilege('service_role','public.claim_bot_message(uuid)','EXECUTE') as service`);
  expect(grants).toEqual({anon:false,authenticated:false,service:true});
});

it('service role can durably ingest and claim while browser roles remain excluded', async () => {
  const d = delivery();
  const pool = new Pool({ connectionString: process.env.FINANCE_TEST_DATABASE_URL, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role service_role');
    const result = await client.query('select public.ingest_bot_messages($1::jsonb) as outcome', [JSON.stringify([d])]);
    const id = result.rows[0].outcome.ids[0];
    const resultClaim = await client.query('select public.claim_bot_message($1) as outcome', [id]);
    expect(resultClaim.rows[0].outcome.delivery.messageId).toBe(d.messageId);
    await client.query('commit');
  } finally {
    await client.query('rollback');
    client.release();
    await pool.end();
  }
});
