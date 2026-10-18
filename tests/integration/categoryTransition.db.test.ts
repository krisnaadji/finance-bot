import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { applyPhase2Migrations, applyPhase3MigrationsThrough, closeFixture, seedLinkedFixture, sql } from './helpers/phase2Db';
import { commitCategoryCommand, prepareCategoryCommand } from './categoryFixture';

beforeAll(applyPhase2Migrations);
afterAll(closeFixture);
it('drains persisted old commands and exports before contracting without rewriting historical financial or delivery identities', async () => {
  const f = await seedLinkedFixture();
  const customId = randomUUID();
  await sql("insert into public.categories(id,account_id,name,type,is_custom,is_active) values($1,$2,'  Original custom  ','expense',true,false)", [customId,f.accountId]);
  const row = {categoryId:f.categoryId,amount:'10.01',type:'expense',description:'original',date:'2026-10-15'};
  const receipt = await prepareCategoryCommand(f,{kind:'create',accountId:f.accountId,recordedByName:'Owner',rows:[row]});
  const created = await commitCategoryCommand(receipt);
  const outbound = created.outboundIds[0];
  await sql("update public.bot_outbound set text='Already frozen original receipt' where id=$1",[outbound]);
  const legacyCommand = {kind:'add_category',accountId:f.accountId,name:'Legacy queued label',type:'expense'};
  const legacy = await prepareCategoryCommand(f,legacyCommand);
  const [{snapshot}] = await sql<{snapshot:{id:string}}>('select public.start_finance_export($1,$2) as snapshot',[f.ownerId,{accountId:f.accountId}]);
  const releasedExport = (await sql<{page:{rows:Record<string,unknown>[]}}>('select public.read_finance_export($1,$2,0,500) as page',[f.ownerId,snapshot.id]))[0].page;
  await sql("insert into public.transactions(account_id,category_id,amount,type,date,description) select $1,id,1.00,'income','2026-10-15','salary' from public.categories where account_id=$1 and type='income'",[f.accountId]);
  const original = await sql('select id,account_id,category_id,amount,date from public.transactions where account_id=$1 order by id',[f.accountId]);
  const originalReply = await sql('select id,text,reply_payload,batch_id from public.bot_outbound where id=$1',[outbound]);
  const originalItems = await sql('select batch_id,item_index,transaction_id from public.bot_batch_items where batch_id=$1',[created.batchId]);
  const summary = async () => (await sql<{value:{categories:Record<string,unknown>[];topExpenses:Record<string,unknown>[];topIncomes:Record<string,unknown>[]}}>(
    "select public.finance_summary($1,'2026-10-01','2026-10-31') as value",[f.accountId]))[0].value;
  const releasedSummary = await summary();
  const expectLegacySummary = async () => {
    const current = await summary();
    expect(current.categories.map(({id,name,amount})=>({id,name,amount}))).toEqual(releasedSummary.categories);
    for (const key of ['topExpenses','topIncomes'] as const) {
      expect(current[key].map(({categories:metadata,parent,...legacy})=>{
        expect(metadata).toMatchObject({name_id:legacy.category});
        expect(parent).toBeNull();
        expect(typeof legacy.category).toBe('string');
        return legacy;
      })).toEqual(releasedSummary[key]);
    }
  };
  await applyPhase3MigrationsThrough('202610150004_hierarchy_exports.sql');
  await expectLegacySummary();
  expect((await sql<{name_id:string;name_en:null}>('select name_id,name_en from public.categories where id=$1',[customId]))[0]).toEqual({name_id:'  Original custom  ',name_en:null});
  await applyPhase3MigrationsThrough('202610150005_category_catalog_activate.sql');
  await expectLegacySummary();
  await expect(applyPhase3MigrationsThrough()).rejects.toThrow('Drain unfinished legacy');
  expect((await commitCategoryCommand(legacy)).code).toBe('category_added');
  expect((await sql<{command:unknown}>('select command from public.bot_inbox where id=$1',[legacy.id]))[0].command).toEqual(legacyCommand);
  await expect(applyPhase3MigrationsThrough()).rejects.toThrow('Finish legacy export');
  const [{page}] = await sql<{page:{rows:Record<string,unknown>[]}}>('select public.read_finance_export($1,$2,0,500) as page',[f.ownerId,snapshot.id]);
  expect(page.rows).toHaveLength(1);
  expect(page.rows[0]).toMatchObject({category:'Makanan',subcategory:''});
  expect(page.rows.map(({subcategory,...legacy})=>{
    expect(subcategory).toBe('');
    return legacy;
  })).toEqual(releasedExport.rows);
  await sql("update public.finance_export_snapshots set expires_at=clock_timestamp()-interval '1 second' where id=$1",[snapshot.id]);
  await sql('select public.cleanup_expired_finance_exports(1000)');
  await sql(`create function public.fixture_live_category_name() returns text language plpgsql set search_path='' as $$
    declare label text; begin select c.name into label from public.categories c limit 1; return label; end $$`);
  await expect(applyPhase3MigrationsThrough()).rejects.toThrow('Live SQL category.name consumer');
  await sql('drop function public.fixture_live_category_name()');
  await sql('create view public.fixture_category_names as select name from public.categories');
  await expect(applyPhase3MigrationsThrough()).rejects.toThrow('Category name dependency');
  await sql('drop view public.fixture_category_names');
  const [{definition}] = await sql<{definition:string}>("select pg_get_functiondef('public.commit_bot_command(uuid,bigint)'::regprocedure) as definition");
  const adapter = '  c=bot_private.category_command(c);';
  for (const replacement of ['', adapter + adapter]) {
    await sql(definition.replace(adapter,replacement));
    await expect(applyPhase3MigrationsThrough()).rejects.toThrow('Unexpected commit definition');
  }
  await sql(definition);
  await applyPhase3MigrationsThrough();
  const finalSummary = await summary();
  for (const category of finalSummary.categories) expect(category).not.toHaveProperty('name');
  for (const top of [...finalSummary.topExpenses,...finalSummary.topIncomes]) {
    expect(top).not.toHaveProperty('category');
    expect(top.categories).toMatchObject({account_id:f.accountId});
  }
  expect((await sql<{definition:string}>("select pg_get_functiondef('public.commit_bot_command(uuid,bigint)'::regprocedure) as definition"))[0].definition).not.toContain('bot_private.category_command(c)');
  expect(await sql("select column_name from information_schema.columns where table_schema='public' and table_name='categories' and column_name='name'")).toEqual([]);
  expect(await sql('select id,account_id,category_id,amount,date from public.transactions where account_id=$1 order by id',[f.accountId])).toEqual(original);
  expect(await sql('select id,text,reply_payload,batch_id from public.bot_outbound where id=$1',[outbound])).toEqual(originalReply);
  expect(await sql('select batch_id,item_index,transaction_id from public.bot_batch_items where batch_id=$1',[created.batchId])).toEqual(originalItems);
  expect((await commitCategoryCommand(receipt)).transactionIds).toEqual(created.transactionIds);
  expect((await commitCategoryCommand(legacy)).code).toBe('category_added');
  expect((await commitCategoryCommand(await prepareCategoryCommand(f,{...legacyCommand,name:'Old shape after cutover'}))).code).toBe('invalid');
  expect(await sql("select id from public.categories where account_id=$1 and name_id='Old shape after cutover'",[f.accountId])).toEqual([]);
});
