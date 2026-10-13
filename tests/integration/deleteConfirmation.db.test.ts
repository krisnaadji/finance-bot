import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { QueryResult } from 'pg';

const connectionString = process.env.FINANCE_TEST_DATABASE_URL;
if (!connectionString) throw new Error('FINANCE_TEST_DATABASE_URL is required for isolated DB tests');
const parsed = new URL(connectionString);
if (!decodeURIComponent(parsed.pathname.slice(1)).startsWith('finance_phase1_test')) {
  throw new Error('Refusing non-disposable database');
}
if (process.env.SUPABASE_URL && parsed.hostname === new URL(process.env.SUPABASE_URL).hostname) {
  throw new Error('Refusing application database host');
}
const approvedHost = process.env.FINANCE_TEST_DATABASE_HOST;
if (!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname) && parsed.hostname !== approvedHost) {
  throw new Error('Remote disposable database host must be explicitly approved');
}
const pool = new Pool({ connectionString, max: 4 });
let ownsFixture = false;
const owner = randomUUID();
const requester = 'fixture-sender-a';
const other = 'fixture-sender-b';
const chat = 'fixture-chat';

interface ConfirmationFixture {
  accountId: string;
  transactionId: string;
  pendingId: string;
}
beforeAll(async () => {
  const existing = await pool.query(`select c.relname as object_name from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind in ('r','p','v','m','f','S')
    union all select p.proname from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and not exists (
      select 1 from pg_catalog.pg_depend d where d.classid='pg_proc'::regclass
        and d.objid=p.oid and d.deptype='e')`);
  if (existing.rows.length) throw new Error('Disposable schema is not empty');
  ownsFixture = true;
  await pool.query(await readFile(new URL('./fixtures/phase1.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../../supabase/migrations/202610120001_expand_delete_confirmations.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../../supabase/migrations/202610120002_enforce_delete_confirmations.sql', import.meta.url), 'utf8'));
});
afterAll(async () => {
  try {
    if (ownsFixture) await pool.query(`
      drop function if exists public.consume_delete_confirmation(uuid,uuid,text,text,text,text);
      drop table if exists public.pending_actions;
      drop table if exists public.transactions;
      drop table if exists public.accounts;
      drop function if exists public.phase1_test_reject_delete();`);
  } finally { await pool.end(); }
});

async function seed(expires = '1 minute'): Promise<ConfirmationFixture> {
  const accountId = randomUUID();
  const transactionId = randomUUID();
  const pendingId = randomUUID();
  await pool.query('insert into public.accounts(id,name,owner_id,wa_chat_id) values($1,$2,$3,$4)',
    [accountId, 'Fixture', owner, chat]);
  await pool.query('insert into public.transactions(id,account_id,amount,type,date) values($1,$2,100,$3,$4)',
    [transactionId, accountId, 'expense', '2026-10-12']);
  await pool.query(`insert into public.pending_actions
    (id,account_id,transaction_id,action,expires_at,requested_by_phone,wa_chat_id,confirmation_message_id)
    values($1,$2,$3,'DELETE',clock_timestamp()+$4::interval,$5,$6,$7)`,
    [pendingId, accountId, transactionId, expires, requester, chat, 'fixture-confirmation']);
  return { accountId, transactionId, pendingId };
}

async function consume(f: ConfirmationFixture, phone = requester, decision = 'confirm', message = 'fixture-confirmation') {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role service_role');
    const result = await client.query(`select public.consume_delete_confirmation($1,$2,$3,$4,$5,$6) as outcome`,
      [f.pendingId, f.accountId, chat, phone, message, decision]);
    await client.query('commit');
    return result.rows[0].outcome as string;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally { client.release(); }
}

async function transactionExists(id: string) {
  const result = await pool.query('select exists(select 1 from public.transactions where id=$1) as present', [id]);
  return result.rows[0].present as boolean;
}

describe('bound delete confirmation in PostgreSQL', () => {
  it('wrong sender cannot consume; the requester can still confirm', async () => {
    const f = await seed();
    expect(await consume(f, other)).toBe('forbidden');
    expect(await transactionExists(f.transactionId)).toBe(true);
    expect(await consume(f)).toBe('deleted');
    expect(await transactionExists(f.transactionId)).toBe(false);
  });
  it('expired confirmation leaves the financial row intact', async () => {
    const f = await seed('-1 second');
    expect(await consume(f)).toBe('expired');
    expect(await transactionExists(f.transactionId)).toBe(true);
  });
  it('concurrent duplicate confirms delete once using independent connections', async () => {
    const f = await seed();
    const outcomes = await Promise.all([consume(f), consume(f)]);
    expect(outcomes.sort()).toEqual(['already_consumed', 'deleted']);
    expect(await transactionExists(f.transactionId)).toBe(false);
  });
  it('concurrent confirm/cancel has one winning action', async () => {
    const f = await seed();
    const outcomes = await Promise.all([consume(f), consume(f, requester, 'cancel')]);
    expect(outcomes.filter(x => x === 'already_consumed')).toHaveLength(1);
    const winner = outcomes.find(x => x !== 'already_consumed');
    expect(['deleted', 'cancelled']).toContain(winner);
    expect(await transactionExists(f.transactionId)).toBe(winner === 'cancelled');
  });
  it('database delete failure rolls back consumption', async () => {
    const f = await seed();
    await pool.query(`create function public.phase1_test_reject_delete() returns trigger language plpgsql as $$
      begin if old.id = '${f.transactionId}'::uuid then raise exception 'fixture rejection'; end if; return old; end $$;
      create trigger phase1_test_reject_delete before delete on public.transactions
      for each row execute function public.phase1_test_reject_delete();`);
    try {
      await expect(consume(f)).rejects.toThrow('fixture rejection');
      expect(await transactionExists(f.transactionId)).toBe(true);
      const row = await pool.query('select id from public.pending_actions where id=$1', [f.pendingId]);
      expect(row.rows.map(r => r.id)).toEqual([f.pendingId]);
    } finally {
      await pool.query('drop trigger phase1_test_reject_delete on public.transactions; drop function public.phase1_test_reject_delete()');
    }
    expect(await consume(f)).toBe('deleted');
  });
  it('inactive account cannot consume an otherwise valid prompt', async () => {
    const f = await seed();
    await pool.query('update public.accounts set is_active=false where id=$1', [f.accountId]);
    expect(await consume(f)).toBe('forbidden');
    expect(await transactionExists(f.transactionId)).toBe(true);
  });
  it('anon and authenticated roles cannot execute the privileged RPC', async () => {
    const result = await pool.query(`select
      has_function_privilege('anon','public.consume_delete_confirmation(uuid,uuid,text,text,text,text)','EXECUTE') as anon,
      has_function_privilege('authenticated','public.consume_delete_confirmation(uuid,uuid,text,text,text,text)','EXECUTE') as authenticated,
      has_function_privilege('service_role','public.consume_delete_confirmation(uuid,uuid,text,text,text,text)','EXECUTE') as service`);
    expect(result.rows[0]).toEqual({ anon: false, authenticated: false, service: true });
  });
  it('two requesters confirming the same target produce one deletion',async()=>{
    const f=await seed(); const second=randomUUID();
    await pool.query(`insert into public.pending_actions
      (id,account_id,transaction_id,action,expires_at,requested_by_phone,wa_chat_id,confirmation_message_id)
      values($1,$2,$3,'DELETE',clock_timestamp()+interval '1 minute',$4,$5,$6)`,
      [second,f.accountId,f.transactionId,other,chat,'other-confirmation']);
    const outcomes=await Promise.all([
      consume(f),consume({...f,pendingId:second},other,'confirm','other-confirmation'),
    ]);
    expect(outcomes.sort()).toEqual(['already_consumed','deleted']);
    expect(await transactionExists(f.transactionId)).toBe(false);
    const remaining=await pool.query('select id from public.pending_actions where account_id=$1',[f.accountId]);
    expect(remaining.rows).toEqual([]);
  });
  it('cancellation leaves another requester and the target intact',async()=>{
    const f=await seed(); const second=randomUUID();
    await pool.query(`insert into public.pending_actions
      (id,account_id,transaction_id,action,expires_at,requested_by_phone,wa_chat_id,confirmation_message_id)
      values($1,$2,$3,'DELETE',clock_timestamp()+interval '1 minute',$4,$5,$6)`,
      [second,f.accountId,f.transactionId,other,chat,'other-confirmation']);
    expect(await consume(f,requester,'cancel')).toBe('cancelled');
    expect(await transactionExists(f.transactionId)).toBe(true);
    const remaining=await pool.query('select id from public.pending_actions where account_id=$1',[f.accountId]);
    expect(remaining.rows.map(row=>row.id)).toEqual([second]);
  });
});

it('different requesters coexist and a replacement invalidates the old prompt', async () => {
  const f = await seed();
  const second = randomUUID();
  await pool.query(`insert into public.pending_actions
    (id,account_id,transaction_id,action,expires_at,requested_by_phone,wa_chat_id,confirmation_message_id)
    values($1,$2,$3,'DELETE',clock_timestamp()+interval '1 minute',$4,$5,$6)`,
    [second,f.accountId,f.transactionId,other,chat,'other-confirmation']);
  const replacement = randomUUID();
  await pool.query(`insert into public.pending_actions
    (id,account_id,transaction_id,action,expires_at,requested_by_phone,wa_chat_id,confirmation_message_id)
    values($1,$2,$3,'DELETE',clock_timestamp()+interval '1 minute',$4,$5,$6)
    on conflict(account_id,wa_chat_id,requested_by_phone) do update set
      id=excluded.id,transaction_id=excluded.transaction_id,expires_at=excluded.expires_at,
      confirmation_message_id=excluded.confirmation_message_id`,
    [replacement,f.accountId,f.transactionId,requester,chat,'replacement-confirmation']);
  expect(await consume(f)).toBe('already_consumed');
  const remaining = await pool.query('select id,requested_by_phone from public.pending_actions where account_id=$1', [f.accountId]);
  expect(new Set(remaining.rows.map(r=>r.id))).toEqual(new Set([second,replacement]));
  expect(await transactionExists(f.transactionId)).toBe(true);
});

it.each([
  ['wrong chat', 'wrong-chat', 'fixture-confirmation'],
  ['wrong message', chat, 'wrong-confirmation'],
  ['missing message', chat, null],
])('rejects %s without consuming the action', async (_label, suppliedChat, message) => {
  const f = await seed();
  const result = await pool.query(
    'select public.consume_delete_confirmation($1,$2,$3,$4,$5,$6) as outcome',
    [f.pendingId, f.accountId, suppliedChat, requester, message, 'confirm']);
  expect(result.rows[0].outcome).toBe('forbidden');
  expect(await transactionExists(f.transactionId)).toBe(true);
  const pending = await pool.query('select id from public.pending_actions where id=$1', [f.pendingId]);
  expect(pending.rows.map(r => r.id)).toEqual([f.pendingId]);
});

it('a foreign-account target cannot be deleted', async () => {
  const a = await seed();
  const b = await seed();
  await pool.query('update public.pending_actions set transaction_id=$1 where id=$2', [b.transactionId, a.pendingId]);
  expect(await consume(a)).toBe('target_missing');
  expect(await transactionExists(a.transactionId)).toBe(true);
  expect(await transactionExists(b.transactionId)).toBe(true);
});

it.each(['anon', 'authenticated'])('denies actual RPC execution to %s', async (role) => {
  const f = await seed();
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${role}`);
    await expect(client.query(
      'select public.consume_delete_confirmation($1,$2,$3,$4,$5,$6)',
      [f.pendingId,f.accountId,chat,requester,'fixture-confirmation','confirm'],
    )).rejects.toMatchObject({ code: '42501' });
  } finally {
    await client.query('rollback');
    client.release();
  }
  expect(await transactionExists(f.transactionId)).toBe(true);
});

it('does not delete when expiry passes while waiting for the target lock', async () => {
  const f = await seed('5 seconds');
  const blocker = await pool.connect();
  const consumer = await pool.connect();
  let action: Promise<QueryResult> | undefined;
  try {
    await blocker.query('begin');
    await blocker.query('select id from public.transactions where id=$1 for update', [f.transactionId]);
    await consumer.query('begin');
    await consumer.query('set local role service_role');
    const pid = (await consumer.query('select pg_backend_pid() as pid')).rows[0].pid;
    action = consumer.query(
      'select public.consume_delete_confirmation($1,$2,$3,$4,$5,$6) as outcome',
      [f.pendingId,f.accountId,chat,requester,'fixture-confirmation','confirm']);
    let waiting = false;
    for (let attempt=0; attempt<100; attempt++) {
      const state = await pool.query('select wait_event_type from pg_stat_activity where pid=$1', [pid]);
      if (state.rows[0]?.wait_event_type === 'Lock') { waiting=true; break; }
    }
    expect(waiting).toBe(true);
    // PostgreSQL's clock cannot be advanced with JS fake timers; wait against the stored expiry after observing the lock.
    await pool.query(`select pg_sleep(greatest(
      extract(epoch from (expires_at-clock_timestamp())),0)::double precision+0.02)
      from public.pending_actions where id=$1`, [f.pendingId]);
    await blocker.query('commit');
    expect((await action).rows[0].outcome).toBe('expired');
    await consumer.query('commit');
    expect(await transactionExists(f.transactionId)).toBe(true);
  } finally {
    await blocker.query('rollback');
    if (action) await action.catch(() => undefined);
    await consumer.query('rollback');
    blocker.release(); consumer.release();
  }
});
