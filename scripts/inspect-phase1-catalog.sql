begin read only;
select n.nspname as schema_name, c.relname as table_name, a.attname as column_name,
       pg_catalog.format_type(a.atttypid, a.atttypmod) as data_type,
       a.attnotnull, pg_catalog.pg_get_expr(d.adbin, d.adrelid) as default_expression
from pg_catalog.pg_attribute a
join pg_catalog.pg_class c on c.oid = a.attrelid
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
where n.nspname = 'public' and c.relname in
 ('accounts','members','categories','transactions','pending_actions','link_codes','invite_tokens','budgets')
 and a.attnum > 0 and not a.attisdropped
order by c.relname, a.attnum;

select conrelid::regclass as table_name, conname,
       pg_catalog.pg_get_constraintdef(oid) as definition
from pg_catalog.pg_constraint
where conrelid in (select c.oid from pg_catalog.pg_class c
 join pg_catalog.pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relname in ('accounts','members','categories','transactions','pending_actions'))
order by conrelid::regclass::text, conname;

select schemaname, tablename, indexname, indexdef from pg_catalog.pg_indexes
where schemaname = 'public' and tablename in ('pending_actions','members','budgets');
select schemaname, tablename, policyname, roles, cmd, qual, with_check
from pg_catalog.pg_policies where schemaname = 'public';
select c.relname, c.relrowsecurity, c.relforcerowsecurity
from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname in ('pending_actions','transactions','accounts');
select t.tgrelid::regclass as table_name, t.tgname, pg_catalog.pg_get_triggerdef(t.oid)
from pg_catalog.pg_trigger t where not t.tgisinternal and t.tgrelid in
 ('public.pending_actions'::regclass,'public.transactions'::regclass,'public.accounts'::regclass);
select n.nspname, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid),
       p.prosecdef, p.proconfig, p.proacl, pg_catalog.pg_get_functiondef(p.oid)
from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('seed_categories','consume_delete_confirmation');
select grantee, table_name, privilege_type from information_schema.role_table_grants
where table_schema='public' and table_name in ('pending_actions','transactions','accounts');
rollback;
