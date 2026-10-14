import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, types } from 'pg';

types.setTypeParser(1082, value => value);

export interface Fixture {
  accountId: string;
  ownerId: string;
  memberId: string;
  chatId: string;
  requester: string;
  categoryId: string;
}

export function assertDisposableDatabase(value: string): void {
  const u = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(u.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) ||
      !/^finance_phase2_test[A-Za-z0-9_]*$/.test(decodeURIComponent(u.pathname.slice(1))) ||
      u.search || u.hash) {
    throw new Error('Refusing non-local disposable database');
  }
}

const url = process.env.FINANCE_TEST_DATABASE_URL;
if (!url) throw new Error('FINANCE_TEST_DATABASE_URL is required');
assertDisposableDatabase(url);
const pool = new Pool({ connectionString: url, max: 8 });
let ownsFixture = false;
let initialized = false;

export async function sql<T>(text: string, values: unknown[] = []): Promise<T[]> {
  return (await pool.query(text, values)).rows as T[];
}

export async function initializeFixture(): Promise<void> {
  if (initialized) return;
  const existing = await sql(`select c.relname from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','auth','bot_private') and c.relkind in ('r','p','v','m','f','S')
    union all select p.proname from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','auth','bot_private') and not exists (
      select 1 from pg_catalog.pg_depend d where d.classid='pg_proc'::regclass
      and d.objid=p.oid and d.deptype='e')`);
  if (existing.length) throw new Error('Disposable schema is not empty');
  const schemas = await sql<{ present: boolean }>(
    "select exists(select 1 from pg_catalog.pg_namespace where nspname in ('auth','bot_private')) as present");
  if (schemas[0].present) throw new Error('Disposable reserved schema is not empty');
  ownsFixture = true;
  await sql(await readFile(new URL('../fixtures/phase2.sql', import.meta.url), 'utf8'));
  for (const file of ['202610120001_expand_delete_confirmations.sql', '202610120002_enforce_delete_confirmations.sql']) {
    await sql(await readFile(new URL(`../../../supabase/migrations/${file}`, import.meta.url), 'utf8'));
  }
  initialized = true;
}

const migrations = [
  '202610130001_durable_intake.sql',
  '202610130002_atomic_bot_mutations.sql',
  '202610130003_delivery_recovery.sql',
  '202610130004_atomic_account_operations.sql',
  '202610130005_exact_reporting.sql',
  '202610130006_export_snapshots.sql',
];
const applied = new Set<string>();
export async function applyPhase2Migrations(): Promise<void> {
  await initializeFixture();
  for (const file of migrations) {
    if (applied.has(file)) continue;
    let source: string;
    try {
      source = await readFile(new URL(`../../../supabase/migrations/${file}`, import.meta.url), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
    await sql(source);
    applied.add(file);
  }
}

export async function seedLinkedFixture(): Promise<Fixture> {
  const f: Fixture = { accountId: randomUUID(), ownerId: randomUUID(), memberId: randomUUID(),
    chatId: `fixture-chat-${randomUUID()}`, requester: `fixture-sender-${randomUUID()}`, categoryId: randomUUID() };
  const outsider = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('insert into auth.users(id) values($1),($2),($3)', [f.ownerId,f.memberId,outsider]);
    await client.query('insert into public.accounts(id,name,owner_id,wa_chat_id) values($1,$2,$3,$4)',
      [f.accountId,'Fixture',f.ownerId,f.chatId]);
    await client.query(`insert into public.members(account_id,user_id,wa_phone,role,display_name)
      values($1,$2,$3,'owner','Fixture owner'),($1,$4,$5,'member','Fixture member')`,
      [f.accountId,f.ownerId,f.requester,f.memberId,`fixture-member-${f.memberId}`]);
    await client.query(`insert into public.categories(id,account_id,name,type)
      values($1,$2,'Makanan','expense'),($3,$2,'Gaji','income')`, [f.categoryId,f.accountId,randomUUID()]);
    await client.query('commit');
    return f;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally { client.release(); }
}

export async function closeFixture(): Promise<void> {
  try {
    if (ownsFixture) {
      await sql('drop schema if exists bot_private cascade; drop schema public cascade; create schema public; drop schema auth cascade');
      ownsFixture = false;
      initialized = false;
      applied.clear();
    }
  } finally { await pool.end(); }
}
