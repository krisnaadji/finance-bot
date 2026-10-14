begin;
set local lock_timeout='5s';
do $$ begin
 if pg_catalog.to_regclass('public.accounts') is null or
    pg_catalog.to_regprocedure('public.consume_delete_confirmation(uuid,uuid,text,text,text,text)') is null then
  raise exception 'Phase 1 schema prerequisite missing';
 end if;
 if pg_catalog.to_regclass('public.bot_inbox') is not null then raise exception 'Durable inbox already exists; verify migration history'; end if;
end $$;
create table public.bot_inbox (
 id uuid primary key default gen_random_uuid(), gateway text not null check(gateway in ('meta','fonnte')),
 message_id text not null check(length(message_id) between 1 and 512),
 chat_id text not null check(length(chat_id) between 1 and 512),
 raw_from text not null check(length(raw_from) between 1 and 512), text text,
 replied_to_id text, received_at timestamptz not null, provider_at timestamptz,
 fingerprint text not null check(fingerprint ~ '^[a-f0-9]{64}$'),
 receipt_order bigint generated always as identity unique,
 state text not null default 'pending' check(state in ('pending','processing','committed','rejected','failed')),
 attempt integer not null default 0 check(attempt between 0 and 5), fence bigint not null default 0,
 lease_until timestamptz, next_attempt_at timestamptz not null default clock_timestamp(),
 next_wake_at timestamptz not null default clock_timestamp(), command jsonb, outcome jsonb,
 diagnostic_code text, terminal_at timestamptz, created_at timestamptz not null default clock_timestamp(),
 unique(gateway,message_id), check(text is null or octet_length(text)<=16384)
);
create index bot_inbox_chat_order on public.bot_inbox(gateway,chat_id,receipt_order)
 where state in ('pending','processing');
create index bot_inbox_due on public.bot_inbox(next_attempt_at,next_wake_at) where state in ('pending','processing');
create table public.bot_chat_claims (
 gateway text not null check(gateway in ('meta','fonnte')), chat_id text not null,
 owner_id uuid references public.bot_inbox(id), fence bigint,
 primary key(gateway,chat_id)
);
alter table public.bot_inbox enable row level security;
alter table public.bot_chat_claims enable row level security;
create policy bot_inbox_service on public.bot_inbox to service_role using(true) with check(true);
create policy bot_chat_claims_service on public.bot_chat_claims to service_role using(true) with check(true);
revoke all on public.bot_inbox,public.bot_chat_claims from public,anon,authenticated;
grant select,insert,update,delete on public.bot_inbox,public.bot_chat_claims to service_role;
grant usage,select on sequence public.bot_inbox_receipt_order_seq to service_role;

create function public.ingest_bot_messages(p_deliveries jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare d jsonb; v public.bot_inbox%rowtype; ids jsonb='[]'; conflicts jsonb='[]';
begin
 if pg_catalog.jsonb_typeof(p_deliveries) is distinct from 'array' then raise exception 'Invalid delivery batch'; end if;
 -- Lock every chat in a consistent order before inserting observed receipt order.
 for d in select distinct pg_catalog.jsonb_build_object('gateway',x->>'gateway','chatId',x->>'chatId')
  from pg_catalog.jsonb_array_elements(p_deliveries) x order by 1
 loop
  if d->>'gateway' not in ('meta','fonnte') or d->>'gateway' is null or
     d->>'chatId' is null or length(d->>'chatId') not between 1 and 512 then raise exception 'Invalid delivery chat'; end if;
  insert into public.bot_chat_claims(gateway,chat_id) values(d->>'gateway',d->>'chatId') on conflict do nothing;
  perform 1 from public.bot_chat_claims where gateway=d->>'gateway' and chat_id=d->>'chatId' for update;
 end loop;
 for d in select value from pg_catalog.jsonb_array_elements(p_deliveries)
 loop
  if pg_catalog.jsonb_typeof(d) is distinct from 'object' or
    d->>'messageId' is null or length(d->>'messageId') not between 1 and 512 or
    d->>'rawFrom' is null or length(d->>'rawFrom') not between 1 and 512 or
    d->>'receivedAt' is null or d->>'fingerprint' is null or
    pg_catalog.jsonb_typeof(d->'text') is distinct from 'string' or
    (d->>'repliedToId' is not null and length(d->>'repliedToId') not between 1 and 512) then
   raise exception 'Invalid delivery';
  end if;
  insert into public.bot_inbox(gateway,message_id,chat_id,raw_from,text,replied_to_id,received_at,provider_at,fingerprint,
    state,diagnostic_code,terminal_at)
  values(d->>'gateway',d->>'messageId',d->>'chatId',d->>'rawFrom',d->>'text',d->>'repliedToId',
    (d->>'receivedAt')::timestamptz,(d->>'providerAt')::timestamptz,d->>'fingerprint',
    case when d->>'rejectionCode' is null then 'pending' else 'rejected' end,d->>'rejectionCode',
    case when d->>'rejectionCode' is null then null else pg_catalog.clock_timestamp() end)
  on conflict(gateway,message_id) do nothing;
  select * into strict v from public.bot_inbox where gateway=d->>'gateway' and message_id=d->>'messageId';
  if v.fingerprint is distinct from d->>'fingerprint' then conflicts=conflicts||pg_catalog.jsonb_build_array(d->>'messageId');
  elsif v.state in ('pending','processing') then ids=ids||pg_catalog.jsonb_build_array(v.id); end if;
 end loop;
 return pg_catalog.jsonb_build_object('ids',ids,'conflicts',conflicts);
end $$;

create function public.claim_bot_message(p_inbox_id uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare v public.bot_inbox%rowtype; c public.bot_chat_claims%rowtype; earliest uuid;
begin
 select * into v from public.bot_inbox where id=p_inbox_id;
 if not found then return null; end if;
 select * into strict c from public.bot_chat_claims where gateway=v.gateway and chat_id=v.chat_id for update;
 select * into v from public.bot_inbox where id=p_inbox_id for update;
 if v.state not in ('pending','processing') or v.next_attempt_at>pg_catalog.clock_timestamp() or
    (v.state='processing' and v.lease_until>pg_catalog.clock_timestamp()) then return null; end if;
 select id into earliest from public.bot_inbox where gateway=v.gateway and chat_id=v.chat_id
  and state in ('pending','processing') order by receipt_order limit 1;
 if earliest is distinct from v.id then return null; end if;
 if c.owner_id is not null and c.owner_id<>v.id and exists(
  select 1 from public.bot_inbox where id=c.owner_id and state='processing' and lease_until>pg_catalog.clock_timestamp()) then return null; end if;
 if v.attempt>=5 then
  update public.bot_inbox set state='failed',lease_until=null,diagnostic_code='attempts_exhausted' where id=v.id;
  update public.bot_chat_claims set owner_id=null,fence=null where gateway=v.gateway and chat_id=v.chat_id and owner_id=v.id;
  return null;
 end if;
 update public.bot_inbox set state='processing',attempt=attempt+1,fence=fence+1,
  lease_until=pg_catalog.clock_timestamp()+interval '60 seconds' where id=v.id returning * into v;
 update public.bot_chat_claims set owner_id=v.id,fence=v.fence where gateway=v.gateway and chat_id=v.chat_id;
 return pg_catalog.jsonb_build_object('id',v.id,'fence',v.fence::text,'attempt',v.attempt,'leaseUntil',v.lease_until,
  'command',v.command,'delivery',pg_catalog.jsonb_build_object('gateway',v.gateway,'messageId',v.message_id,
   'chatId',v.chat_id,'rawFrom',v.raw_from,'text',v.text,'repliedToId',v.replied_to_id,
   'receivedAt',v.received_at,'providerAt',v.provider_at,'fingerprint',v.fingerprint));
end $$;

create function public.renew_bot_claim(p_inbox_id uuid,p_fence bigint) returns boolean
language plpgsql security invoker set search_path='' as $$
begin
 update public.bot_inbox set lease_until=pg_catalog.clock_timestamp()+interval '60 seconds'
 where id=p_inbox_id and fence=p_fence and state='processing' and lease_until>pg_catalog.clock_timestamp();
 return found;
end $$;

create function public.save_bot_command(p_inbox_id uuid,p_fence bigint,p_command jsonb) returns boolean
language plpgsql security invoker set search_path='' as $$
begin
 if pg_catalog.jsonb_typeof(p_command) is distinct from 'object' then return false; end if;
 update public.bot_inbox set command=p_command where id=p_inbox_id and fence=p_fence
 and state='processing' and lease_until>pg_catalog.clock_timestamp() and (command is null or command=p_command);
 return found;
end $$;

create function public.fail_bot_message(p_inbox_id uuid,p_fence bigint,p_code text,p_retryable boolean) returns boolean
language plpgsql security invoker set search_path='' as $$
declare v public.bot_inbox%rowtype; delay interval;
begin
 select * into v from public.bot_inbox where id=p_inbox_id;
 if not found then return false; end if;
 perform 1 from public.bot_chat_claims where gateway=v.gateway and chat_id=v.chat_id for update;
 select * into v from public.bot_inbox where id=p_inbox_id for update;
 if v.fence<>p_fence or v.state<>'processing' or v.lease_until<=pg_catalog.clock_timestamp() then return false; end if;
 if p_code is null or p_code !~ '^[a-z0-9_]{1,80}$' then raise exception 'Invalid diagnostic code'; end if;
 delay=(array[interval '5 seconds',interval '30 seconds',interval '2 minutes',interval '10 minutes'])[v.attempt];
 update public.bot_inbox set state=case when p_retryable and v.attempt<5 then 'pending' when p_retryable then 'failed' else 'rejected' end,
  next_attempt_at=pg_catalog.clock_timestamp()+coalesce(delay,interval '0 seconds'),lease_until=null,
  diagnostic_code=p_code,terminal_at=case when not p_retryable then pg_catalog.clock_timestamp() else null end where id=v.id;
 update public.bot_chat_claims set owner_id=null,fence=null where gateway=v.gateway and chat_id=v.chat_id and owner_id=v.id and fence=p_fence;
 return true;
end $$;

revoke all on function public.ingest_bot_messages(jsonb),public.claim_bot_message(uuid),
 public.renew_bot_claim(uuid,bigint),public.save_bot_command(uuid,bigint,jsonb),public.fail_bot_message(uuid,bigint,text,boolean)
 from public,anon,authenticated;
grant execute on function public.ingest_bot_messages(jsonb),public.claim_bot_message(uuid),
 public.renew_bot_claim(uuid,bigint),public.save_bot_command(uuid,bigint,jsonb),public.fail_bot_message(uuid,bigint,text,boolean)
 to service_role;
commit;
