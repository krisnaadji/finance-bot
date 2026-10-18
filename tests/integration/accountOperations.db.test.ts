import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  applyPhase2MigrationsThrough, closeFixture, initializeFixture, seedLinkedFixture, sql,
} from './helpers/phase2Db';
import type { Fixture } from './helpers/phase2Db';

type Claim = { id: string; fence: string };
type Outcome = { outcome: string; code: string };
type RpcResult = Record<string, unknown>;

beforeAll(async () => {
  await initializeFixture();
  await applyPhase2MigrationsThrough('202610130004_atomic_account_operations.sql');
});
afterAll(closeFixture);

async function createAccount(
  userId = randomUUID(), operationId = randomUUID(), name = 'Household', displayName: string | null = 'Account owner',
) {
  await sql('insert into auth.users(id) values($1)', [userId]);
  const [result] = await sql<{ value: RpcResult }>(
    'select public.create_finance_account($1,$2,$3,$4,$5) as value',
    [userId, operationId, name, 'group', displayName],
  );
  return { userId, operationId, result: result.value };
}

async function prepared(f: Fixture, command: unknown): Promise<Claim> {
  const delivery = {
    gateway: 'meta', messageId: randomUUID(), chatId: f.chatId, rawFrom: f.requester,
    text: 'fixture command', repliedToId: null, receivedAt: new Date().toISOString(),
    providerAt: null, fingerprint: 'b'.repeat(64),
  };
  const [{ value }] = await sql<{ value: { ids: string[] } }>(
    'select public.ingest_bot_messages($1::jsonb) as value', [JSON.stringify([delivery])],
  );
  const [{ claim }] = await sql<{ claim: Claim }>(
    'select public.claim_bot_message($1) as claim', [value.ids[0]],
  );
  await sql('select public.save_bot_command($1,$2,$3::jsonb)',
    [claim.id, claim.fence, JSON.stringify(command)]);
  return claim;
}

async function commit(claim: Claim): Promise<Outcome> {
  const [result] = await sql<{ value: Outcome }>(
    'select public.commit_bot_command($1,$2) as value', [claim.id, claim.fence],
  );
  return result.value;
}

async function setupClaim(f: Fixture, code: string): Promise<Claim> {
  return prepared(f, { kind: 'setup', code, language: 'id' });
}

it('rolls account, owner membership, and idempotency record back when category seeding fails', async () => {
  const userId = randomUUID(), operationId = randomUUID();
  await sql('insert into auth.users(id) values($1)', [userId]);
  await sql(`create function public.fixture_fail_seed() returns trigger language plpgsql as $$
    begin raise exception 'fixture seed failure'; end $$;
    create trigger fixture_fail_seed before insert on public.categories
    for each row execute function public.fixture_fail_seed()`);
  try {
    await expect(sql('select public.create_finance_account($1,$2,$3,$4,$5)',
      [userId, operationId, 'Rollback account', 'personal', 'Owner'])).rejects.toThrow('fixture seed failure');
  } finally {
    await sql('drop trigger fixture_fail_seed on public.categories;drop function public.fixture_fail_seed()');
  }
  const [counts] = await sql<{ accounts: number; members: number; operations: number }>(
    `select (select count(*)::int from public.accounts where owner_id=$1) as accounts,
      (select count(*)::int from public.members where user_id=$1) as members,
      (select count(*)::int from public.account_creation_operations where owner_id=$1) as operations`, [userId],
  );
  expect(counts).toEqual({ accounts: 0, members: 0, operations: 0 });
});
function accountId(result: RpcResult): string {
  const account = result.account;
  if (!account || typeof account !== 'object' || !('id' in account) || typeof account.id !== 'string') {
    throw new Error('accepted account response omitted account id');
  }
  return account.id;
}


it('returns the original account for an identical operation and conflicts on changed payload', async () => {
  const created = await createAccount();
  expect(created.result.code).toBe('accepted');
  const seeded = await sql<{id:string}>('select id from public.categories where account_id=$1 order by id', [accountId(created.result)]);
  expect(seeded.length).toBeGreaterThan(0);
  const [retry] = await sql<{ value: RpcResult }>(
    'select public.create_finance_account($1,$2,$3,$4,$5) as value',
    [created.userId, created.operationId, '  Household  ', 'group', '  Account owner  '],
  );
  expect(retry.value).toEqual(created.result);
  expect(accountId(retry.value)).toBe(accountId(created.result));
  const [owner] = await sql<{ role: string; display_name: string }>(
    'select role,display_name from public.members where account_id=$1 and user_id=$2',
    [accountId(created.result), created.userId],
  );
  expect(owner).toEqual({ role: 'owner', display_name: 'Account owner' });

  const [changed] = await sql<{ value: RpcResult }>(
    'select public.create_finance_account($1,$2,$3,$4,$5) as value',
    [created.userId, created.operationId, 'Different household', 'group', 'Account owner'],
  );
  expect(changed.value).toEqual({ code: 'conflict' });
  expect(await sql('select id from public.categories where account_id=$1 order by id', [accountId(created.result)])).toEqual(seeded);
});
it('preserves account creation when the owner has no display name', async () => {
  const created = await createAccount(randomUUID(), randomUUID(), 'Unnamed owner', null);
  expect(created.result.code).toBe('accepted');
  const [owner] = await sql<{ display_name: string | null }>(
    'select display_name from public.members where user_id=$1 and role=$2', [created.userId, 'owner'],
  );
  expect(owner.display_name).toBeNull();
});

it('replaces a link code with a 15-minute code and consumes the previous code atomically', async () => {
  const f = await seedLinkedFixture(), previous = randomUUID(), replacement = randomUUID();
  await sql("insert into public.link_codes(account_id,code,expires_at) values($1,$2,clock_timestamp()+interval '15 minutes')",
    [f.accountId, previous]);
  const [result] = await sql<{ value: { code: string; linkCode: { code: string; expiresAt: string } } }>(
    'select public.replace_finance_link_code($1,$2,$3) as value', [f.ownerId, f.accountId, replacement],
  );
  expect(result.value.code).toBe('accepted');
  expect(result.value.linkCode.code).toBe(replacement);
  const [{ valid }] = await sql<{ valid: boolean }>(
    `select expires_at between clock_timestamp()+interval '14 minutes' and clock_timestamp()+interval '16 minutes' as valid
     from public.link_codes where account_id=$1 and code=$2 and not used`, [f.accountId, replacement],
  );
  expect(valid).toBe(true);
  const previousRow = await sql<{ used: boolean }>(
    'select used from public.link_codes where account_id=$1 and code=$2', [f.accountId, previous],
  );
  expect(previousRow).toEqual([{ used: true }]);
});

it('uses the database unique constraint for link-code collision outcomes', async () => {
  const f = await seedLinkedFixture(), other = await seedLinkedFixture(), code = randomUUID();
  await sql("insert into public.link_codes(account_id,code,expires_at) values($1,$3,clock_timestamp()+interval '15 minutes'),($2,$4,clock_timestamp()+interval '15 minutes')",
    [f.accountId, other.accountId, 'prior-' + code, 'taken-' + code]);
  const [result] = await sql<{ value: RpcResult }>(
    'select public.replace_finance_link_code($1,$2,$3) as value', [f.ownerId, f.accountId, 'taken-' + code],
  );
  expect(result.value).toEqual({ code: 'collision' });
  const prior = await sql<{ used: boolean }>(
    'select used from public.link_codes where account_id=$1 and code=$2', [f.accountId, 'prior-' + code],
  );
  expect(prior).toEqual([{ used: false }]);
});

it('keeps a prior link code usable when inserting its replacement fails', async () => {
  const f = await seedLinkedFixture(), oldCode = randomUUID().toUpperCase();
  await sql('update public.accounts set wa_chat_id=null where id=$1', [f.accountId]);
  await sql("insert into public.link_codes(account_id,code,expires_at) values($1,$2,clock_timestamp()+interval '15 minutes')",
    [f.accountId, oldCode]);
  await sql(`create function public.fixture_fail_link_insert() returns trigger language plpgsql as $$
    begin raise exception 'fixture link insertion failure'; end $$;
    create trigger fixture_fail_link_insert before insert on public.link_codes
    for each row execute function public.fixture_fail_link_insert()`);
  try {
    await expect(sql('select public.replace_finance_link_code($1,$2,$3)',
      [f.ownerId, f.accountId, randomUUID()])).rejects.toThrow('fixture link insertion failure');
  } finally {
    await sql('drop trigger fixture_fail_link_insert on public.link_codes;drop function public.fixture_fail_link_insert()');
  }
  const [old] = await sql<{ used: boolean }>('select used from public.link_codes where code=$1', [oldCode]);
  expect(old.used).toBe(false);
  const result = await commit(await setupClaim(f, oldCode));
  expect(result.code).toBe('setup_ok');
  const [account] = await sql<{ wa_chat_id: string }>('select wa_chat_id from public.accounts where id=$1', [f.accountId]);
  expect(account.wa_chat_id).toBe(f.chatId);
});

it('allows only one concurrent invite recipient and rejects the competing redeemer', async () => {
  const f = await seedLinkedFixture(), token = randomUUID(), first = randomUUID(), second = randomUUID();
  await sql('insert into auth.users(id) values($1),($2)', [first, second]);
  await sql("insert into public.invite_tokens(account_id,token,expires_at) values($1,$2,clock_timestamp()+interval '15 minutes')",
    [f.accountId, token]);
  const results = await Promise.all([first, second].map(userId => sql<{ value: RpcResult }>(
    'select public.redeem_finance_invite($1,$2,$3) as value', [userId, token, 'Invitee'],
  )));
  const codes = results.map(rows => rows[0].value.code).sort();
  expect(codes).toEqual(['accepted', 'conflict']);
  const memberships = await sql<{ count: number }>(
    'select count(*)::int as count from public.members where account_id=$1 and user_id in ($2,$3)',
    [f.accountId, first, second],
  );
  expect(memberships[0].count).toBe(1);
});

it('makes same-recipient invite redemption retries idempotent', async () => {
  const f = await seedLinkedFixture(), token = randomUUID(), invitee = randomUUID();
  await sql('insert into auth.users(id) values($1)', [invitee]);
  await sql("insert into public.invite_tokens(account_id,token,expires_at) values($1,$2,clock_timestamp()+interval '15 minutes')",
    [f.accountId, token]);
  const redeem = () => sql<{ value: RpcResult }>(
    'select public.redeem_finance_invite($1,$2,$3) as value', [invitee, token, 'Invitee'],
  );
  const first = (await redeem())[0].value, retry = (await redeem())[0].value;
  expect(first).toEqual(retry);
  expect(first.code).toBe('accepted');
  const memberships = await sql<{ count: number }>(
    'select count(*)::int as count from public.members where account_id=$1 and user_id=$2',
    [f.accountId, invitee],
  );
  expect(memberships[0].count).toBe(1);
});

it('allows invite redemption when the user has no display name', async () => {
  const f = await seedLinkedFixture(), token = randomUUID(), invitee = randomUUID();
  await sql('insert into auth.users(id) values($1)', [invitee]);
  await sql("insert into public.invite_tokens(account_id,token,expires_at) values($1,$2,clock_timestamp()+interval '15 minutes')",
    [f.accountId, token]);
  const [result] = await sql<{ value: RpcResult }>(
    'select public.redeem_finance_invite($1,$2,$3) as value', [invitee, token, null],
  );
  expect(result.value.code).toBe('accepted');
  const [member] = await sql<{ display_name: string | null }>(
    'select display_name from public.members where account_id=$1 and user_id=$2', [f.accountId, invitee],
  );
  expect(member.display_name).toBeNull();
});

it('serializes competing setup linkers on a single link code', async () => {
  const f = await seedLinkedFixture(), code = randomUUID().toUpperCase();
  await sql('update public.accounts set wa_chat_id=null where id=$1', [f.accountId]);
  await sql("insert into public.link_codes(account_id,code,expires_at) values($1,$2,clock_timestamp()+interval '15 minutes')",
    [f.accountId, code]);
  const first = { ...f, chatId: randomUUID(), requester: 'fixture-linker-first' };
  const second = { ...f, chatId: randomUUID(), requester: 'fixture-linker-second' };
  const claims = await Promise.all([setupClaim(first, code), setupClaim(second, code)]);
  const results = await Promise.all(claims.map(commit));
  expect(results.map(result => result.code).sort()).toEqual(['setup_bad_code', 'setup_ok']);
  const winner = results[0].code === 'setup_ok' ? first : second;
  const [account] = await sql<{ wa_chat_id: string }>('select wa_chat_id from public.accounts where id=$1', [f.accountId]);
  expect(account.wa_chat_id).toBe(winner.chatId);
  const members = await sql<{ wa_phone: string }>(
    'select wa_phone from public.members where account_id=$1 and wa_phone in ($2,$3) order by wa_phone',
    [f.accountId, first.requester, second.requester],
  );
  expect(members).toEqual([{ wa_phone: winner.requester }]);
});
