import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { initializePhase3Fixture, closeFixture, sql, sqlAs } from './helpers/phase3Db';

const migration = new URL('../../supabase/migrations/202610180001_account_operation_access.sql', import.meta.url);
beforeAll(async () => {
  await initializePhase3Fixture();
  // Match actual Supabase instead of the native fixture's broad auth-table grants.
  await sql('revoke all on auth.users from service_role');
});
afterAll(closeFixture);

it('repairs account and invite RPC access with only the Auth ID column and is repeatable', async () => {
  const owner = randomUUID(), member = randomUUID(), operation = randomUUID(), token = randomUUID();
  await sql('insert into auth.users(id,email) values($1,$2),($3,$4)',
    [owner,'owner@example.test',member,'member@example.test']);
  const args = [owner,operation,'Auth access fixture','group',null];
  await expect(sqlAs('service_role','select public.create_finance_account($1,$2,$3,$4,$5)',args))
    .rejects.toThrow('permission denied for table users');
  await sql(await readFile(migration,'utf8'));
  const [created] = await sqlAs<{result:{code:string;account:{id:string}}}>('service_role',
    'select public.create_finance_account($1,$2,$3,$4,$5) as result',args);
  expect(created.result.code).toBe('accepted');
  await sql('insert into public.invite_tokens(account_id,token,expires_at) values($1,$2,clock_timestamp()+interval \'1 hour\')',
    [created.result.account.id,token]);
  const [joined] = await sqlAs<{result:{code:string;accountId:string}}>('service_role',
    'select public.redeem_finance_invite($1,$2,$3) as result',[member,token,null]);
  expect(joined.result).toMatchObject({code:'accepted',accountId:created.result.account.id});
  const [joinedAgain] = await sqlAs<{result:unknown}>('service_role',
    'select public.redeem_finance_invite($1,$2,$3) as result',[member,token,null]);
  expect(joinedAgain.result).toEqual(joined.result);
  await expect(sqlAs('service_role','select email from auth.users')).rejects.toThrow('permission denied');
  expect(await sqlAs('service_role','select id from auth.users where id=$1',[owner])).toEqual([{id:owner}]);
  await sql(await readFile(migration,'utf8'));
  const [replayed] = await sqlAs<{result:unknown}>('service_role',
    'select public.create_finance_account($1,$2,$3,$4,$5) as result',args);
  expect(replayed.result).toEqual(created.result);
  const [unknown] = await sqlAs<{result:unknown}>('service_role',
    'select public.create_finance_account($1,$2,$3,$4,$5) as result',
    [randomUUID(),randomUUID(),'Unknown user','personal',null]);
  expect(unknown.result).toEqual({code:'forbidden'});
});

it.each(['anon','authenticated'] as const)('keeps Auth IDs and account RPCs inaccessible to %s',async role=>{
  await expect(sqlAs(role,'select id from auth.users')).rejects.toThrow('permission denied');
  await expect(sqlAs(role,'select public.create_finance_account($1,$2,$3,$4,$5)',
    [randomUUID(),randomUUID(),'Forbidden','personal',null])).rejects.toThrow('permission denied');
});
