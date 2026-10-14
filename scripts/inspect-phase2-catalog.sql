begin read only;
select n.nspname as schema_name,c.relname as table_name,a.attname as column_name,
 pg_catalog.format_type(a.atttypid,a.atttypmod) as type,a.attnotnull as not_null,
 pg_catalog.pg_get_expr(d.adbin,d.adrelid) as default_expression
from pg_catalog.pg_attribute a
join pg_catalog.pg_class c on c.oid=a.attrelid
join pg_catalog.pg_namespace n on n.oid=c.relnamespace
left join pg_catalog.pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum
where n.nspname='public' and c.relkind in ('r','p') and a.attnum>0 and not a.attisdropped
order by c.relname,a.attnum;
select c.relname as table_name,k.conname,k.contype,pg_catalog.pg_get_constraintdef(k.oid) as definition
from pg_catalog.pg_constraint k join pg_catalog.pg_class c on c.oid=k.conrelid
join pg_catalog.pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' order by c.relname,k.conname;
select schemaname,tablename,indexname,indexdef from pg_catalog.pg_indexes
where schemaname='public' order by tablename,indexname;
select c.relname,c.relrowsecurity,c.relforcerowsecurity from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relkind in ('r','p') order by c.relname;
select schemaname,tablename,policyname,roles,cmd,qual,with_check from pg_catalog.pg_policies
where schemaname='public' order by tablename,policyname;
select p.oid::regprocedure as signature, p.prosecdef as security_definer,p.proconfig,
 pg_catalog.pg_get_functiondef(p.oid) as definition,p.proacl
from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.prokind in ('f','p') and not exists (
 select 1 from pg_catalog.pg_depend d where d.classid='pg_proc'::regclass
 and d.objid=p.oid and d.deptype='e') order by p.oid::regprocedure::text;
select table_schema,table_name,grantee,privilege_type from information_schema.table_privileges
where table_schema='public' order by table_name,grantee,privilege_type;
select name,setting,unit from pg_catalog.pg_settings
where name in ('server_version','max_connections','statement_timeout','lock_timeout','TimeZone');
select pg_catalog.current_setting('pgrst.db_max_rows',true) as postgrest_db_max_rows,
 pg_catalog.current_setting('pgrst.db_schemas',true) as postgrest_db_schemas;
commit;
