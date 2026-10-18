begin;
set local lock_timeout='5s';
do $$ begin
 if pg_catalog.to_regprocedure('bot_private.enforce_category_hierarchy()') is null or
    pg_catalog.to_regprocedure('public.commit_bot_command(uuid,bigint)') is null then raise exception 'Category operation prerequisites missing'; end if;
end $$;
create function bot_private.category_label(p_id text,p_en text,p_locale text) returns text
language sql immutable set search_path='' as $$
 select case when p_locale='en' then coalesce(nullif(btrim(p_en),''),nullif(btrim(p_id),''))
 else coalesce(nullif(btrim(p_id),''),nullif(btrim(p_en),'')) end
$$;
create function bot_private.category_path(p_id uuid,p_account uuid,p_type text,p_locale text) returns text
language sql stable set search_path='' as $$
 select case when c.parent_id is null then bot_private.category_label(c.name_id,c.name_en,p_locale)
 else bot_private.category_label(p.name_id,p.name_en,p_locale)||' / '||bot_private.category_label(c.name_id,c.name_en,p_locale) end
 from public.categories c left join public.categories p on p.id=c.parent_id and p.account_id=c.account_id and p.type=c.type
 where c.id=p_id and c.account_id=p_account and c.type=p_type
$$;
create function bot_private.enforce_parent_budget() returns trigger language plpgsql set search_path='' as $$
begin
 perform 1 from public.accounts where id=new.account_id for update;
 perform 1 from public.categories where id=new.category_id and account_id=new.account_id and type='expense' and parent_id is null and is_active;
 if not found then raise exception 'Budget requires an active expense root' using errcode='23514'; end if;
 return new;
end $$;
create trigger budgets_parent_only before insert or update of account_id,category_id,amount on public.budgets for each row execute function bot_private.enforce_parent_budget();
create or replace function public.valid_bot_transaction(p_row jsonb,p_account_id uuid,p_allow_inactive boolean default false) returns boolean
language plpgsql security invoker set search_path='' as $$
declare v_date date; v_category uuid; v_parent uuid;
begin
 if pg_catalog.jsonb_typeof(p_row) is distinct from 'object' or exists(
  select 1 from pg_catalog.jsonb_object_keys(p_row) k where k not in ('categoryId','amount','type','description','date')) then return false; end if;
 if pg_catalog.jsonb_typeof(p_row->'amount') is distinct from 'string' or
  p_row->>'amount' !~ '^(0|[1-9][0-9]{0,12})\.[0-9]{2}$' or (p_row->>'amount')::numeric<=0 or
  (p_row->>'amount')::numeric>9999999999999.99 or
  p_row->>'type' is null or p_row->>'type' not in ('income','expense') or
  pg_catalog.jsonb_typeof(p_row->'description') is distinct from 'string' or
  pg_catalog.jsonb_typeof(p_row->'date') is distinct from 'string' or p_row->>'date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return false; end if;
 v_date=(p_row->>'date')::date;
 if v_date<'2000-01-01'::date or v_date>'2100-12-31'::date or v_date::text<>p_row->>'date' then return false; end if;
 if not p_row ? 'categoryId' then return false; end if;
 if p_allow_inactive then return true; end if;
 perform 1 from public.accounts where id=p_account_id for update;
 if p_row->>'categoryId' is not null then
  v_category=(p_row->>'categoryId')::uuid;
  select parent_id into v_parent from public.categories where id=v_category and account_id=p_account_id
   and is_active=true and type=p_row->>'type';
  if not found then return false; end if;
  if v_parent is not null then
   perform 1 from public.categories where id=v_parent and account_id=p_account_id and type=p_row->>'type' and is_active and parent_id is null;
   if not found then return false; end if;
  end if;
 end if;
 return true;
exception when invalid_text_representation or datetime_field_overflow or invalid_datetime_format or numeric_value_out_of_range then return false;
end $$;


create function bot_private.enforce_transaction_category() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='UPDATE' and (new.account_id,new.category_id,new.type) is not distinct from (old.account_id,old.category_id,old.type) then return new; end if;
 if not public.valid_bot_transaction(pg_catalog.jsonb_build_object('categoryId',new.category_id,'amount',new.amount::text,'type',new.type,
   'description',coalesce(new.description,''),'date',new.date::text),new.account_id) then
  raise exception 'Invalid transaction selection' using errcode='23514'; end if;
 return new;
end $$;
create trigger transactions_category_eligibility before insert or update of account_id,category_id,type on public.transactions for each row execute function bot_private.enforce_transaction_category();
-- The persisted command is never rewritten. This adapter exists only for the bounded rollout window.
create function bot_private.category_command(p_command jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
begin
 if p_command->>'kind'='add_category' and p_command ? 'name' and
    not exists(select 1 from pg_catalog.jsonb_object_keys(p_command) k where k not in ('kind','accountId','name','type')) then
  return (p_command-'name')||pg_catalog.jsonb_build_object('nameId',p_command->'name','nameEn',null,'parentId',null);
 end if;
 return p_command;
end $$;
create or replace function public.commit_bot_command(p_inbox_id uuid,p_fence bigint) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare
 v public.bot_inbox%rowtype; a public.accounts%rowtype; c jsonb; j jsonb; rows jsonb='[]'; snapshot jsonb;
 txn public.transactions%rowtype; category_row public.categories%rowtype; category_name text; v_lang text='id'; v_code text='ok'; v_kind text='ordinary';
 v_batch uuid; v_pending uuid; v_outbound uuid; v_expiry timestamptz; v_index integer=0;
 ids jsonb='[]'; v_account uuid; v_setup jsonb; allowed text[]; v_outcome jsonb;
begin
 select * into v from public.bot_inbox where id=p_inbox_id;
 if not found then raise exception 'Unknown inbox identity'; end if;
 perform 1 from public.bot_chat_claims where gateway=v.gateway and chat_id=v.chat_id for update;
 select * into v from public.bot_inbox where id=p_inbox_id for update;
 if v.outcome is not null then return v.outcome||pg_catalog.jsonb_build_object('outcome','replayed'); end if;
 if v.fence<>p_fence or v.state<>'processing' or v.lease_until<=pg_catalog.clock_timestamp() then raise exception 'Inbox claim lost'; end if;
 c=v.command;
 if pg_catalog.jsonb_typeof(c) is distinct from 'object' then raise exception 'Prepared command missing'; end if;
 begin
  c=bot_private.category_command(c);
  allowed=case c->>'kind'
   when 'create' then array['kind','accountId','rows','recordedByName']
   when 'edit' then array['kind','accountId','transactionId','before','editedByName','patch']
   when 'delete_prompt' then array['kind','accountId','transactionId']
   when 'delete_decision' then array['kind','accountId','pendingId','confirmationMessageId','decision']
   when 'add_category' then array['kind','accountId','type','nameId','nameEn','parentId']
   when 'setup' then array['kind','code','language']
   when 'set_language' then array['kind','accountId','language']
   when 'reply' then array['kind','accountId','reply'] end;
  if allowed is null or exists(select 1 from pg_catalog.jsonb_object_keys(c) k where not k=any(allowed)) then v_code='invalid'; end if;
  if c->>'accountId' is not null then
   v_account=(c->>'accountId')::uuid;
   select * into a from public.accounts where id=v_account and is_active=true and wa_chat_id=v.chat_id for update;
   if not found then v_code='inactive';v_account=null;
   else
    select coalesce(m.language_pref,a.language) into v_lang from public.members m where m.account_id=a.id and m.wa_phone=v.raw_from;
    v_lang=coalesce(v_lang,a.language,'id');
   end if;
  elsif c->>'kind' not in ('setup','reply') then v_code='invalid'; end if;
  if v_lang not in ('id','en') then v_lang='id'; end if;
  if v_code='ok' and c->>'kind' in ('create','edit','delete_prompt','delete_decision','add_category') and not exists(
   select 1 from public.members where account_id=v_account and wa_phone=v.raw_from) then v_code='forbidden'; end if;
  if v_code='ok' then
   case c->>'kind'
   when 'create' then
    if pg_catalog.jsonb_typeof(c->'rows') is distinct from 'array' or pg_catalog.jsonb_array_length(c->'rows') not between 1 and 100 then v_code='invalid';
    else
     for j in select value from pg_catalog.jsonb_array_elements(c->'rows') loop
      if not public.valid_bot_transaction(j,v_account) then v_code='invalid'; exit; end if;
     end loop;
     if v_code='ok' then
      insert into public.bot_batches(inbox_id,account_id) values(v.id,v_account) returning id into v_batch;
      for j in select value from pg_catalog.jsonb_array_elements(c->'rows') loop
       v_index=v_index+1;
       insert into public.transactions(account_id,category_id,amount,type,description,date,raw_message,wa_user_message_id,recorded_by_name,recorded_by_phone)
       values(v_account,(j->>'categoryId')::uuid,(j->>'amount')::numeric,j->>'type',j->>'description',(j->>'date')::date,
        v.text,v.message_id,coalesce(c->>'recordedByName',v.raw_from),v.raw_from) returning * into txn;
       insert into public.bot_batch_items(batch_id,item_index,transaction_id) values(v_batch,v_index,txn.id);
       category_name=bot_private.category_path(txn.category_id,v_account,txn.type,v_lang);
       rows=rows||pg_catalog.jsonb_build_array(j||pg_catalog.jsonb_build_object('index',v_index,'id',txn.id,'categoryName',category_name));
       ids=ids||pg_catalog.jsonb_build_array(txn.id);
      end loop;
      insert into public.bot_receipt_ids(gateway,message_id,batch_id) values(v.gateway,v.message_id,v_batch);
      v_kind='receipt';v_code='created';
     end if;
    end if;
   when 'edit' then
    select * into txn from public.transactions where id=(c->>'transactionId')::uuid and account_id=v_account for update;
    if not found then v_code='missing';
    elsif pg_catalog.jsonb_typeof(c->'patch') is distinct from 'object' or c->'patch'='{}'::jsonb or
      pg_catalog.jsonb_typeof(c->'editedByName') is distinct from 'string' then v_code='invalid';
    else
     j=pg_catalog.jsonb_build_object('categoryId',txn.category_id,'amount',txn.amount::text,'type',txn.type,'description',coalesce(txn.description,''),'date',txn.date::text);
     if c->'before' is distinct from j then v_code='conflict';
     else
      j=j||(c->'patch');
      if not public.valid_bot_transaction(j,v_account,not (c->'patch' ? 'categoryId') and not (c->'patch' ? 'type')) then v_code='invalid';
      else
       update public.transactions set category_id=(j->>'categoryId')::uuid,amount=(j->>'amount')::numeric,type=j->>'type',
        description=j->>'description',date=(j->>'date')::date,edited_by_name=c->>'editedByName',updated_at=pg_catalog.clock_timestamp()
        where id=txn.id returning * into txn;
       insert into public.bot_batches(inbox_id,account_id) values(v.id,v_account) returning id into v_batch;
       insert into public.bot_batch_items(batch_id,item_index,transaction_id) values(v_batch,1,txn.id);
       insert into public.bot_receipt_ids(gateway,message_id,batch_id) values(v.gateway,v.message_id,v_batch);
       category_name=bot_private.category_path(txn.category_id,v_account,txn.type,v_lang);
       rows=pg_catalog.jsonb_build_array(j||pg_catalog.jsonb_build_object('index',1,'id',txn.id,'categoryName',category_name));
       ids=pg_catalog.jsonb_build_array(txn.id);v_code='edited';v_kind='receipt';
      end if;
     end if;
    end if;
   when 'delete_prompt' then
    select * into txn from public.transactions where id=(c->>'transactionId')::uuid and account_id=v_account for update;
    if not found then v_code='missing'; else
     delete from public.pending_actions where account_id=v_account and wa_chat_id=v.chat_id and requested_by_phone=v.raw_from;
     v_expiry=pg_catalog.clock_timestamp()+interval '60 seconds';
     insert into public.pending_actions(account_id,transaction_id,action,expires_at,requested_by_phone,wa_chat_id)
      values(v_account,txn.id,'DELETE',v_expiry,v.raw_from,v.chat_id) returning id into v_pending;
     category_name=bot_private.category_path(txn.category_id,v_account,txn.type,v_lang);
     rows=pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('index',1,'id',txn.id,'amount',txn.amount::text,'type',txn.type,'description',coalesce(txn.description,''),'date',txn.date::text,'categoryId',txn.category_id,'categoryName',category_name));
     v_code='delete_prompt';v_kind='confirmation';
    end if;
   when 'delete_decision' then
    v_code=public.consume_delete_confirmation((c->>'pendingId')::uuid,v_account,v.chat_id,v.raw_from,c->>'confirmationMessageId',c->>'decision');
   when 'add_category' then
    if not exists(select 1 from public.members m join public.accounts owner_account on owner_account.id=m.account_id
      where m.account_id=v_account and m.wa_phone=v.raw_from and m.user_id=owner_account.owner_id) then v_code='forbidden';
    elsif c->>'type' is null or c->>'type' not in ('income','expense') or
      not c ?& array['nameId','nameEn','parentId'] or
      pg_catalog.jsonb_typeof(c->'nameId') not in ('string','null') or
      pg_catalog.jsonb_typeof(c->'nameEn') not in ('string','null') or
      pg_catalog.jsonb_typeof(c->'parentId') not in ('string','null') or
      (nullif(btrim(c->>'nameId'),'') is null and nullif(btrim(c->>'nameEn'),'') is null) then v_code='invalid';
    else
     insert into public.categories(account_id,name_id,name_en,parent_id,type,is_custom)
      values(v_account,nullif(btrim(c->>'nameId'),''),nullif(btrim(c->>'nameEn'),''),
       (c->>'parentId')::uuid,c->>'type',true) returning * into category_row;
     category_name=bot_private.category_path(category_row.id,v_account,category_row.type,v_lang);
     v_code='category_added';
    end if;
   when 'set_language' then
    if c->>'language' is null or c->>'language' not in ('id','en') then v_code='invalid'; else
     update public.members set language_pref=c->>'language' where account_id=v_account and wa_phone=v.raw_from;
     if not found then
      insert into public.members(account_id,wa_phone,language_pref) values(v_account,v.raw_from,c->>'language');
     end if;
     v_lang=c->>'language';v_code='language_changed';
    end if;
   when 'setup' then
    v_setup=bot_private.apply_bot_setup(c->>'code',v.chat_id,v.raw_from,c->>'language');v_code=v_setup->>'code';
    if v_code='setup_ok' then v_account=(v_setup->>'accountId')::uuid;v_lang=c->>'language'; end if;
   when 'reply' then
    if pg_catalog.jsonb_typeof(c->'reply') is distinct from 'object' or
     pg_catalog.jsonb_typeof(c->'reply'->'text') is distinct from 'string' or
     c->'reply'->>'kind' is null or c->'reply'->>'kind' not in ('ordinary','help') or exists(
      select 1 from pg_catalog.jsonb_object_keys(c->'reply') k where k not in ('text','kind')) then v_code='invalid';
    else v_kind=c->'reply'->>'kind';v_code='reply'; end if;
   else v_code='invalid';
   end case;
  end if;
 exception when invalid_text_representation or datetime_field_overflow or invalid_datetime_format or numeric_value_out_of_range or check_violation or foreign_key_violation then
  v_code='invalid';v_batch=null;ids='[]';rows='[]';v_pending=null;v_kind='ordinary';
 when unique_violation then
  v_code='conflict';v_batch=null;ids='[]';rows='[]';v_pending=null;v_kind='ordinary';
 end;
 snapshot=pg_catalog.jsonb_build_object('language',v_lang,'kind',v_kind,'code',v_code,'rows',rows,
  'text',case when v_code='reply' then c->'reply'->>'text' else null end,
  'categoryName',case when v_code='category_added' then category_name else null end,
  'categoryType',case when v_code='category_added' then c->>'type' else null end,
  'accountName',case when v_code='setup_ok' then v_setup->>'accountName' else null end);
 insert into public.bot_outbound(inbox_id,account_id,gateway,destination,kind,batch_id,pending_id,expires_at,reply_payload)
  values(v.id,v_account,v.gateway,v.chat_id,v_kind,v_batch,v_pending,v_expiry,snapshot) returning id into v_outbound;
 v_outcome=pg_catalog.jsonb_build_object('outcome',case when v_code in ('invalid','inactive','missing','conflict','setup_bad_code','forbidden') then 'rejected' else 'committed' end,
  'code',v_code,'batchId',v_batch,'transactionIds',ids,'outboundIds',pg_catalog.jsonb_build_array(v_outbound));
 update public.bot_inbox set state=case when v_outcome->>'outcome'='rejected' then 'rejected' else 'committed' end,
  outcome=v_outcome,lease_until=null,terminal_at=pg_catalog.clock_timestamp()
  where id=v.id and fence=p_fence and state='processing' and lease_until>pg_catalog.clock_timestamp();
 if not found then raise exception 'Inbox claim lost'; end if;
 update public.bot_chat_claims set owner_id=null,fence=null where gateway=v.gateway and chat_id=v.chat_id and owner_id=v.id and fence=p_fence;
 return v_outcome;
end $$;


create table public.category_translation_quotas (
 user_id uuid not null references auth.users(id) on delete cascade,
 account_id uuid not null references public.accounts(id) on delete cascade,
 window_start timestamptz not null,request_count integer not null check(request_count between 1 and 10),
 primary key(user_id,account_id)
);
alter table public.category_translation_quotas enable row level security;
create policy category_translation_service on public.category_translation_quotas to service_role using(true) with check(true);
revoke all on public.category_translation_quotas from public,anon,authenticated;
grant select,insert,update,delete on public.category_translation_quotas to service_role;
create function public.reserve_category_translation(p_user_id uuid,p_account_id uuid) returns boolean
language plpgsql security invoker set search_path='' as $$
declare v_count integer; v_now timestamptz;
begin
 perform 1 from public.accounts where id=p_account_id and owner_id=p_user_id and is_active for share;
 if not found then return false; end if;
 v_now=pg_catalog.clock_timestamp();
 insert into public.category_translation_quotas(user_id,account_id,window_start,request_count)
 values(p_user_id,p_account_id,v_now,1)
 on conflict(user_id,account_id) do update set
 window_start=case when category_translation_quotas.window_start<=v_now-interval '60 seconds' then v_now else category_translation_quotas.window_start end,
 request_count=case when category_translation_quotas.window_start<=v_now-interval '60 seconds' then 1 else category_translation_quotas.request_count+1 end
 where category_translation_quotas.window_start<=v_now-interval '60 seconds' or category_translation_quotas.request_count<10
 returning request_count into v_count;
 return found;
end $$;
revoke all on function bot_private.category_label(text,text,text),bot_private.category_path(uuid,uuid,text,text),
 bot_private.enforce_parent_budget(),bot_private.enforce_transaction_category(),bot_private.category_command(jsonb),public.reserve_category_translation(uuid,uuid) from public,anon,authenticated;
grant execute on function bot_private.category_label(text,text,text),bot_private.category_path(uuid,uuid,text,text),
 bot_private.category_command(jsonb),public.reserve_category_translation(uuid,uuid) to service_role;
commit;
