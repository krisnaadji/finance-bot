begin;
set local lock_timeout='5s';
do $$ begin
 if pg_catalog.to_regprocedure('bot_private.category_catalog()') is null or
    pg_catalog.to_regprocedure('bot_private.category_command(jsonb)') is null or
    pg_catalog.to_regprocedure('bot_private.finance_selection(uuid,jsonb)') is null or
    not exists(select 1 from information_schema.columns where table_schema='public' and table_name='categories' and column_name='name') then
  raise exception 'Category contract prerequisites missing'; end if;
end $$;
-- Stop old writers before this migration. Locking prevents a preflight/contract race.
lock table public.accounts,public.categories,public.bot_inbox,public.finance_export_snapshots in share row exclusive mode;
do $$ declare dependency text; definition text; bridge text; expected integer; begin
 if exists(select 1 from public.bot_inbox where outcome is null and command->>'kind'='add_category' and command ? 'name') then
  raise exception 'Drain unfinished legacy add_category commands before category contraction'; end if;
 if exists(select 1 from public.finance_export_snapshots where expires_at>pg_catalog.clock_timestamp() and format_version<2) then
  raise exception 'Finish legacy export snapshots or wait for their TTL before category contraction'; end if;
 if exists(select 1 from public.accounts a cross join bot_private.category_catalog() expected
  left join public.categories c on c.account_id=a.id and c.code=expected.code
  left join public.categories p on p.id=c.parent_id and p.account_id=c.account_id
  where c.id is null or c.is_custom or c.type<>expected.type or
   (expected.parent_code is null and c.parent_id is not null) or
   (expected.parent_code is not null and p.code is distinct from expected.parent_code)) then
  raise exception 'Complete and review catalog activation before category contraction'; end if;
 -- New clients consume categories metadata; retire only the old summary label keys.
 definition=pg_catalog.pg_get_functiondef('public.finance_summary(uuid,date,date)'::regprocedure);
 for bridge,expected in select * from (values
  ($bridge$'name',coalesce(bot_private.category_label(c.name_id,c.name_en,'id'),'Other'),$bridge$,1),
  ($bridge$'category',coalesce(bot_private.category_label(category_json->>'name_id',category_json->>'name_en','id'),'—'),$bridge$,2)
 ) compatibility(fragment,occurrences) loop
  if (pg_catalog.length(definition)-pg_catalog.length(pg_catalog.replace(definition,bridge,'')))<>expected*pg_catalog.length(bridge) then
   raise exception 'Unexpected summary definition; review category compatibility removal'; end if;
  definition=pg_catalog.replace(definition,bridge,'');
 end loop;
 execute definition;
 select p.oid::regprocedure::text into dependency from pg_catalog.pg_proc p
 join pg_catalog.pg_namespace n on n.oid=p.pronamespace
 where n.nspname not in ('pg_catalog','information_schema') and n.nspname !~ '^pg_' and p.prokind in ('f','p')
  and p.oid<>'bot_private.category_name_bridge()'::regprocedure
  and pg_catalog.replace(pg_catalog.pg_get_functiondef(p.oid),'"','') ~* '\mcategories\M'
  and (pg_catalog.replace(pg_catalog.pg_get_functiondef(p.oid),'"','') ~* '\m[a-z_][a-z_0-9]*\s*\.\s*name\M'
   or pg_catalog.replace(pg_catalog.pg_get_functiondef(p.oid),'"','') ~* '(select|insert|update)[^;]*\mname\M[^;]*\mcategories\M'
   or pg_catalog.replace(pg_catalog.pg_get_functiondef(p.oid),'"','') ~* '\mcategories\M[^;]*(\(|set|select)[^;]*\mname\M') limit 1;
 if found then raise exception 'Live SQL category.name consumer requires migration: %',dependency; end if;
 select pg_catalog.pg_describe_object(d.classid,d.objid,d.objsubid) into dependency
 from pg_catalog.pg_depend d join pg_catalog.pg_attribute a on a.attrelid=d.refobjid and a.attnum=d.refobjsubid
 where a.attrelid='public.categories'::regclass and a.attname='name' and not a.attisdropped
  limit 1;
 if found then raise exception 'Category name dependency requires explicit migration: %',dependency; end if;
end $$;
-- Remove exactly the rollout-only adapter call without replacing unrelated reviewed
-- commit behavior. Match without its newline: stored bodies preserve LF or CRLF.
-- A missing/duplicated statement blocks contraction.
do $$ declare definition text; statement constant text='  c=bot_private.category_command(c);'; begin
 definition=pg_catalog.pg_get_functiondef('public.commit_bot_command(uuid,bigint)'::regprocedure);
 if (pg_catalog.length(definition)-pg_catalog.length(pg_catalog.replace(definition,statement,'')))<>pg_catalog.length(statement) then
  raise exception 'Unexpected commit definition; review category compatibility removal'; end if;
 execute pg_catalog.replace(definition,statement,'');
end $$;
drop function bot_private.category_command(jsonb);
drop trigger categories_00_name_bridge on public.categories;
drop function bot_private.category_name_bridge();
alter table public.categories drop column name;
notify pgrst,'reload schema';
commit;
