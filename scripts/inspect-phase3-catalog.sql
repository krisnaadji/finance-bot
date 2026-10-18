begin read only;
-- Schema-only inventory. No financial rows, connection settings or credentials.
select current_user,
 pg_catalog.has_schema_privilege('service_role','auth','USAGE') as service_auth_usage,
 pg_catalog.has_column_privilege('service_role','auth.users','id','SELECT') as service_auth_id_select,
 pg_catalog.has_table_privilege('service_role','public.account_creation_operations','UPDATE') as service_account_lock,
 pg_catalog.has_table_privilege('service_role','public.invite_redemptions','UPDATE') as service_invite_lock;
select n.nspname,c.relname,a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod) as type,a.attnotnull
from pg_catalog.pg_attribute a join pg_catalog.pg_class c on c.oid=a.attrelid
join pg_catalog.pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname in ('categories','budgets','transactions','bot_inbox','finance_export_rows')
 and a.attnum>0 and not a.attisdropped order by c.relname,a.attnum;
select p.oid::regprocedure as signature,p.prosecdef,p.proconfig,p.proacl,pg_catalog.pg_get_functiondef(p.oid) as definition
from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
where n.nspname in ('public','bot_private') and p.prokind='f' and
 (p.proname='seed_categories' or pg_catalog.pg_get_functiondef(p.oid) ilike '%categor%'
  or pg_catalog.pg_get_functiondef(p.oid) ilike '%budget%');
select conrelid::regclass,conname,pg_catalog.pg_get_constraintdef(oid)
from pg_catalog.pg_constraint where conrelid in ('public.categories'::regclass,'public.budgets'::regclass,'public.transactions'::regclass);
select tgrelid::regclass,tgname,pg_catalog.pg_get_triggerdef(oid)
from pg_catalog.pg_trigger where tgrelid in ('public.categories'::regclass,'public.budgets'::regclass,'public.transactions'::regclass) and not tgisinternal;
select pg_catalog.pg_describe_object(d.classid,d.objid,d.objsubid) as dependent,a.attname,d.deptype
from pg_catalog.pg_depend d join pg_catalog.pg_attribute a on a.attrelid=d.refobjid and a.attnum=d.refobjsubid
where a.attrelid='public.categories'::regclass and a.attname in ('name','code','parent_id');
select schemaname,viewname,definition from pg_catalog.pg_views
where definition ilike '%categories%' and schemaname not in ('pg_catalog','information_schema');
select schemaname,tablename,indexname,indexdef from pg_catalog.pg_indexes
where schemaname='public' and tablename in ('categories','budgets','transactions') order by tablename,indexname;
select grantee,table_name,privilege_type from information_schema.role_table_grants
where table_schema='public' and table_name in ('categories','budgets','transactions') order by table_name,grantee,privilege_type;
select schemaname,tablename,policyname,roles,cmd,qual,with_check from pg_catalog.pg_policies
where schemaname='public' and tablename in ('categories','budgets','transactions');
commit;
