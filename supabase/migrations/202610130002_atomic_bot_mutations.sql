begin;
set local lock_timeout='5s';
do $$ begin
 if pg_catalog.to_regclass('public.bot_inbox') is null then raise exception 'Durable intake prerequisite missing'; end if;
 if pg_catalog.to_regclass('public.bot_batches') is not null then raise exception 'Atomic command schema already exists'; end if;
 if not exists(select 1 from pg_catalog.pg_attribute where attrelid='public.transactions'::regclass and attname='amount'
  and pg_catalog.format_type(atttypid,atttypmod)='numeric(15,2)' and not attisdropped) then raise exception 'Review transaction numeric schema'; end if;
end $$;
create schema bot_private;
revoke all on schema bot_private from public,anon,authenticated;
grant usage on schema bot_private to service_role;
create table public.bot_batches (
 id uuid primary key default gen_random_uuid(), inbox_id uuid not null unique references public.bot_inbox(id),
 account_id uuid not null references public.accounts(id), created_at timestamptz not null default clock_timestamp()
);
create table public.bot_batch_items (
 batch_id uuid not null references public.bot_batches(id), item_index integer not null check(item_index between 1 and 100),
 transaction_id uuid references public.transactions(id) on delete set null, primary key(batch_id,item_index)
);
create table public.bot_receipt_ids (
 gateway text not null check(gateway in ('meta','fonnte')), message_id text not null,
 batch_id uuid not null references public.bot_batches(id), primary key(gateway,message_id)
);
create table public.bot_legacy_receipt_items (
 gateway text not null check(gateway in ('meta','fonnte')), message_id text not null,
 account_id uuid not null references public.accounts(id), item_index integer not null check(item_index between 1 and 100),
 transaction_id uuid references public.transactions(id) on delete set null,
 primary key(gateway,message_id,account_id,item_index)
);
create table public.bot_outbound (
 id uuid primary key default gen_random_uuid(), inbox_id uuid not null references public.bot_inbox(id),
 logical_index integer not null default 1, account_id uuid references public.accounts(id),
 gateway text not null check(gateway in ('meta','fonnte')), destination text not null,
 kind text not null check(kind in ('ordinary','receipt','help','confirmation')),
 batch_id uuid references public.bot_batches(id), pending_id uuid references public.pending_actions(id) on delete set null,
 expires_at timestamptz, reply_payload jsonb not null, text text,
 state text not null default 'pending' check(state in ('pending','sending','accepted','rejected','uncertain','resolved')),
 attempt integer not null default 0 check(attempt between 0 and 5), fence bigint not null default 0,
 attempt_id uuid, lease_until timestamptz, next_attempt_at timestamptz not null default clock_timestamp(),
 provider_message_id text, diagnostic_code text, created_at timestamptz not null default clock_timestamp(),
 unique(inbox_id,logical_index)
);
alter table public.bot_batches enable row level security;
alter table public.bot_batch_items enable row level security;
alter table public.bot_receipt_ids enable row level security;
alter table public.bot_outbound enable row level security;
alter table public.bot_legacy_receipt_items enable row level security;
create policy bot_batches_service on public.bot_batches to service_role using(true) with check(true);
create policy bot_batch_items_service on public.bot_batch_items to service_role using(true) with check(true);
create policy bot_receipt_ids_service on public.bot_receipt_ids to service_role using(true) with check(true);
create policy bot_outbound_service on public.bot_outbound to service_role using(true) with check(true);
create policy bot_legacy_receipts_service on public.bot_legacy_receipt_items to service_role using(true) with check(true);
revoke all on public.bot_batches,public.bot_batch_items,public.bot_receipt_ids,public.bot_outbound,public.bot_legacy_receipt_items from public,anon,authenticated;
grant select,insert,update,delete on public.bot_batches,public.bot_batch_items,public.bot_receipt_ids,public.bot_outbound,public.bot_legacy_receipt_items to service_role;
create table public.bot_help_context (
 gateway text not null check(gateway in ('meta','fonnte')), provider_message_id text not null,
 account_id uuid not null references public.accounts(id), chat_id text not null, expires_at timestamptz not null,
 primary key(gateway,provider_message_id,account_id,chat_id)
);
alter table public.bot_help_context enable row level security;
create policy bot_help_context_service on public.bot_help_context to service_role using(true) with check(true);
revoke all on public.bot_help_context from public,anon,authenticated;
grant select,insert,update,delete on public.bot_help_context to service_role;

create function public.load_bot_help_context(p_account_id uuid,p_chat_id text,p_gateway text,p_message_id text) returns boolean
language sql stable security invoker set search_path='' as $$
 select exists(select 1 from public.bot_help_context h join public.accounts a on a.id=h.account_id
  where h.account_id=p_account_id and h.chat_id=p_chat_id and h.gateway=p_gateway and h.provider_message_id=p_message_id
    and h.expires_at>pg_catalog.clock_timestamp() and a.is_active=true and a.wa_chat_id=p_chat_id)
$$;
revoke all on function public.load_bot_help_context(uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.load_bot_help_context(uuid,text,text,text) to service_role;

create function public.valid_bot_transaction(p_row jsonb,p_account_id uuid,p_allow_inactive boolean default false) returns boolean
language plpgsql security invoker set search_path='' as $$
declare v_date date; v_category uuid;
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
 if p_row->>'categoryId' is not null then
  v_category=(p_row->>'categoryId')::uuid;
  perform 1 from public.categories where id=v_category and account_id=p_account_id
   and (is_active=true or p_allow_inactive=true) and type=p_row->>'type' for share;
  if not found then return false; end if;
 end if;
 return true;
exception when invalid_text_representation or datetime_field_overflow or invalid_datetime_format or numeric_value_out_of_range then return false;
end $$;

create function bot_private.apply_bot_setup(p_code text,p_chat_id text,p_requester text,p_language text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare v_account public.accounts%rowtype; v_code public.link_codes%rowtype;
begin
 if p_language not in ('id','en') or p_language is null then return pg_catalog.jsonb_build_object('code','invalid'); end if;
 select * into v_code from public.link_codes where code=upper(p_code);
 if not found then return pg_catalog.jsonb_build_object('code','setup_bad_code'); end if;
 select * into v_account from public.accounts where id=v_code.account_id for update;
 if not found or not v_account.is_active then return pg_catalog.jsonb_build_object('code','inactive'); end if;
 select * into v_code from public.link_codes where id=v_code.id for update;
 if v_code.used or v_code.expires_at<=pg_catalog.clock_timestamp() then return pg_catalog.jsonb_build_object('code','setup_bad_code'); end if;
 update public.accounts set wa_chat_id=p_chat_id,language=p_language where id=v_account.id;
 perform 1 from public.members where account_id=v_account.id and wa_phone=p_requester;
 if not found then
  insert into public.members(account_id,wa_phone,role) values(v_account.id,p_requester,'member');
 end if;
 update public.link_codes set used=true where id=v_code.id and used=false;
 return pg_catalog.jsonb_build_object('code','setup_ok','accountId',v_account.id,'accountName',v_account.name);
end $$;

create function public.commit_bot_command(p_inbox_id uuid,p_fence bigint) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare
 v public.bot_inbox%rowtype; a public.accounts%rowtype; c jsonb; j jsonb; rows jsonb='[]'; snapshot jsonb;
 txn public.transactions%rowtype; category_name text; v_lang text='id'; v_code text='ok'; v_kind text='ordinary';
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
  allowed=case c->>'kind'
   when 'create' then array['kind','accountId','rows','recordedByName']
   when 'edit' then array['kind','accountId','transactionId','before','editedByName','patch']
   when 'delete_prompt' then array['kind','accountId','transactionId']
   when 'delete_decision' then array['kind','accountId','pendingId','confirmationMessageId','decision']
   when 'add_category' then array['kind','accountId','name','type']
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
       select name into category_name from public.categories where id=txn.category_id;
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
       select name into category_name from public.categories where id=txn.category_id;
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
     select name into category_name from public.categories where id=txn.category_id;
     rows=pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('index',1,'id',txn.id,'amount',txn.amount::text,'type',txn.type,'description',coalesce(txn.description,''),'date',txn.date::text,'categoryId',txn.category_id,'categoryName',category_name));
     v_code='delete_prompt';v_kind='confirmation';
    end if;
   when 'delete_decision' then
    v_code=public.consume_delete_confirmation((c->>'pendingId')::uuid,v_account,v.chat_id,v.raw_from,c->>'confirmationMessageId',c->>'decision');
   when 'add_category' then
    if pg_catalog.jsonb_typeof(c->'name') is distinct from 'string' or length(trim(c->>'name'))=0 or
     c->>'type' is null or c->>'type' not in ('income','expense') then v_code='invalid';
    elsif exists(select 1 from public.categories where account_id=v_account and lower(trim(name))=lower(trim(c->>'name'))) then v_code='conflict';
    else insert into public.categories(account_id,name,type,is_custom) values(v_account,trim(c->>'name'),c->>'type',true);v_code='category_added'; end if;
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
  'categoryName',case when v_code='category_added' then c->>'name' else null end,
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

create function public.lookup_bot_receipt(p_account_id uuid,p_gateway text,p_message_id text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare v_batch uuid; result jsonb;
begin
 select r.batch_id into v_batch from public.bot_receipt_ids r join public.bot_batches b on b.id=r.batch_id
 where r.gateway=p_gateway and r.message_id=p_message_id and b.account_id=p_account_id;
 if v_batch is not null then
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('index',item_index,'transactionId',transaction_id) order by item_index),'[]'::jsonb)
   into result from public.bot_batch_items where batch_id=v_batch;
  return result;
 end if;
 select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('index',item_index,'transactionId',transaction_id) order by item_index),'[]'::jsonb)
  into result from public.bot_legacy_receipt_items
  where account_id=p_account_id and gateway=p_gateway and message_id=p_message_id;
 return result;
end $$;
revoke all on function public.valid_bot_transaction(jsonb,uuid,boolean),bot_private.apply_bot_setup(text,text,text,text),
 public.commit_bot_command(uuid,bigint),public.lookup_bot_receipt(uuid,text,text) from public,anon,authenticated;
grant execute on function public.valid_bot_transaction(jsonb,uuid,boolean),bot_private.apply_bot_setup(text,text,text,text),
 public.commit_bot_command(uuid,bigint),public.lookup_bot_receipt(uuid,text,text) to service_role;
commit;
