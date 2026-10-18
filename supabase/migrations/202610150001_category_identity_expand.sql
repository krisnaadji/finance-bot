begin;
set local lock_timeout='5s';
do $$ begin
 if pg_catalog.to_regprocedure('public.commit_bot_command(uuid,bigint)') is null or
    pg_catalog.to_regprocedure('public.seed_categories(uuid)') is null or
    not exists(select 1 from information_schema.columns where table_schema='public' and table_name='categories' and column_name='name' and data_type='text') then
  raise exception 'Phase 3 category identity prerequisites missing'; end if;
end $$;
lock table public.categories in share row exclusive mode;
alter table public.categories add column code text,add column name_id text,add column name_en text,
 add column parent_id uuid references public.categories(id) on delete restrict;
create temporary table phase3_legacy_map(code text,type text,legacy_name text,name_id text,name_en text) on commit drop;
insert into phase3_legacy_map values
 ('expense.basic_needs','expense','Kebutuhan Pokok','Kebutuhan Pokok','Basic Needs'),
 ('expense.housing','expense','Tagihan','Rumah & Tagihan','Housing & Bills'),
 ('expense.transport','expense','Transportasi','Transportasi','Transport'),
 ('expense.health','expense','Kesehatan','Kesehatan','Health'),
 ('expense.work','expense','Kebutuhan Pekerjaan','Pekerjaan & Usaha','Work & Business'),
 ('expense.debt','expense','Cicilan','Cicilan & Utang','Installments & Debt'),
 ('expense.entertainment','expense','Hiburan','Hiburan & Rekreasi','Entertainment & Recreation'),
 ('expense.shopping','expense','Shopping','Belanja Pribadi','Personal Shopping'),
 ('expense.donations','expense','Donasi','Donasi & Bantuan','Donations & Support'),
 ('expense.education','expense','Pendidikan','Pendidikan','Education'),
 ('expense.savings','expense','Tabungan','Tabungan','Savings'),
 ('expense.investments','expense','Investasi','Investasi','Investments'),
 ('expense.top_up','expense','Top Up','Top Up','Top Up'),
 ('expense.other','expense','Pengeluaran Lainnya','Pengeluaran Lainnya','Other Expenses'),
 ('salary','income','Gaji','Gaji','Salary'),
 ('income.sales','income','Penjualan','Penjualan & Jasa','Sales & Services'),
 ('income.profit_sharing','income','Bagi Hasil','Bagi Hasil','Profit Sharing'),
 ('income.investments','income','Investasi','Hasil Investasi','Investment Income'),
 ('income.top_up','income','Top Up','Top Up','Top Up'),
 ('income.other','income','Pemasukan Lainnya','Pemasukan Lainnya','Other Income');
-- Only exact noncustom/type/name tuples are mapping candidates. This is not a certification of a production catalog.
do $$ declare ambiguous record; begin
 select c.account_id,c.type,c.name,count(*) into ambiguous from public.categories c
 join phase3_legacy_map m on m.type=c.type and m.legacy_name=c.name
 where not c.is_custom group by c.account_id,c.type,c.name having count(*)>1 limit 1;
 if found then raise exception 'Ambiguous legacy default mapping: account %, type %, name %',ambiguous.account_id,ambiguous.type,ambiguous.name; end if;
 if exists(select 1 from public.categories where nullif(btrim(name),'') is null) then
  raise exception 'Blank legacy category labels require explicit review'; end if;
end $$;
update public.categories set name_id=name;
update public.categories c set code=m.code,name_id=m.name_id,name_en=m.name_en
from phase3_legacy_map m where not c.is_custom and c.type=m.type and c.name=m.legacy_name;
do $$ begin
 if exists(
  select 1 from (
   select account_id,type,'id' as locale,lower(btrim(name_id)) as label from public.categories where is_active and nullif(btrim(name_id),'') is not null
   union all
   select account_id,type,'en',lower(btrim(name_en)) from public.categories where is_active and nullif(btrim(name_en),'') is not null
  ) labels group by account_id,type,locale,label having count(*)>1
 ) then raise exception 'Existing active sibling label collision requires explicit review'; end if;
end $$;
alter table public.categories add constraint categories_bilingual_label check(
 nullif(btrim(name_id),'') is not null or nullif(btrim(name_en),'') is not null);
create unique index categories_account_code_unique on public.categories(account_id,code) where code is not null;
create index categories_parent_idx on public.categories(parent_id) where parent_id is not null;
create function bot_private.category_name_bridge() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='INSERT' then
  if new.name_id is null and new.name_en is null then new.name_id=new.name; end if;
 elsif new.name is distinct from old.name and new.name_id is not distinct from old.name_id and new.name_en is not distinct from old.name_en then
  new.name_id=new.name;
 end if;
 new.name=coalesce(nullif(btrim(new.name_id),''),nullif(btrim(new.name_en),''));
 return new;
end $$;
create trigger categories_00_name_bridge before insert or update on public.categories for each row execute function bot_private.category_name_bridge();
create function bot_private.enforce_category_hierarchy() returns trigger language plpgsql set search_path='' as $$
declare p public.categories%rowtype;
begin
 -- All graph and eligibility changes share the account row lock, including sibling duplicate checks.
 perform 1 from public.accounts where id=new.account_id for update;
 if tg_op='UPDATE' and (new.account_id,new.type,new.parent_id,new.code,new.is_custom) is distinct from
  (old.account_id,old.type,old.parent_id,old.code,old.is_custom) then
  raise exception 'Category identity and parent are immutable' using errcode='23514'; end if;
 if new.code='salary' and (new.parent_id is not null or new.type<>'income') then
  raise exception 'Salary must be an income root' using errcode='23514'; end if;
 if new.parent_id is not null then
  select * into p from public.categories where id=new.parent_id;
  if not found or p.id=new.id or p.account_id<>new.account_id or p.type<>new.type or p.parent_id is not null or p.code='salary' then
   raise exception 'Invalid category parent' using errcode='23514'; end if;
  if new.is_active and not p.is_active and (tg_op='INSERT' or not old.is_active) then
   raise exception 'Inactive category parent' using errcode='23514'; end if;
 end if;
 if new.is_active and exists(select 1 from public.categories c where c.id<>new.id and c.account_id=new.account_id
  and c.type=new.type and c.parent_id is not distinct from new.parent_id and c.is_active and
  ((nullif(btrim(new.name_id),'') is not null and lower(btrim(c.name_id))=lower(btrim(new.name_id))) or
   (nullif(btrim(new.name_en),'') is not null and lower(btrim(c.name_en))=lower(btrim(new.name_en))))) then
  raise exception 'Duplicate active sibling category label' using errcode='23505'; end if;
 return new;
end $$;
create trigger categories_10_hierarchy before insert or update on public.categories for each row execute function bot_private.enforce_category_hierarchy();
revoke all on function bot_private.category_name_bridge(),bot_private.enforce_category_hierarchy() from public,anon,authenticated;
commit;
