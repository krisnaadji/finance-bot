begin;
set local lock_timeout='5s';
alter table public.bot_outbound add column retryable boolean not null default false;
alter table public.bot_outbound add column recovery_note text;
alter table public.bot_outbound add column next_wake_at timestamptz not null default clock_timestamp();
create index bot_outbound_due on public.bot_outbound(next_attempt_at,next_wake_at)
 where state in ('pending','rejected');
create table public.bot_delivery_audit (
 id bigint generated always as identity primary key,outbound_id uuid not null references public.bot_outbound(id),
 action text not null check(action in ('show','resume','bind-id','resend-uncertain','resolve')),result_code text not null,
 created_at timestamptz not null default clock_timestamp()
);
alter table public.bot_delivery_audit enable row level security;
create policy bot_delivery_audit_service on public.bot_delivery_audit to service_role using(true) with check(true);
revoke all on public.bot_delivery_audit from public,anon,authenticated;
grant select,insert on public.bot_delivery_audit to service_role;
grant usage,select on sequence public.bot_delivery_audit_id_seq to service_role;
create function public.freeze_bot_reply(p_outbound_id uuid,p_text text) returns boolean
language plpgsql security invoker set search_path='' as $$
declare r public.bot_outbound%rowtype;
begin
 if pg_catalog.octet_length(p_text)>60000 then raise exception 'Reply too long'; end if;
 update public.bot_outbound set text=p_text where id=p_outbound_id and text is null and state='pending' returning * into r;
 if found then return true; end if;
 select * into r from public.bot_outbound where id=p_outbound_id;
 return found and r.text=p_text;
end $$;
create function public.claim_bot_outbound(p_outbound_id uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare r public.bot_outbound%rowtype; v_fence bigint;
begin
 select * into r from public.bot_outbound where id=p_outbound_id for update;
 if not found or r.text is null then return null; end if;
 if r.state='sending' then
  if r.lease_until>clock_timestamp() then return null; end if;
  update public.bot_outbound set state='uncertain',diagnostic_code='interrupted_send',lease_until=null where id=r.id;
  return null;
 end if;
 if r.state not in ('pending','rejected') or (r.state='rejected' and not r.retryable) or r.next_attempt_at>clock_timestamp() or r.attempt>=5 then return null; end if;
 if r.expires_at is not null and r.expires_at<=clock_timestamp() then update public.bot_outbound set state='resolved',diagnostic_code='expired' where id=r.id; return null; end if;
 if r.account_id is not null and not exists(select 1 from public.accounts a where a.id=r.account_id and a.is_active=true and a.wa_chat_id=r.destination) then
  update public.bot_outbound set state='resolved',diagnostic_code='access_changed' where id=r.id;return null;
 end if;
 v_fence=r.fence+1;
 update public.bot_outbound set state='sending',fence=v_fence,attempt=attempt+1,attempt_id=gen_random_uuid(),lease_until=clock_timestamp()+interval '60 seconds',retryable=false
  where id=r.id returning * into r;
 return pg_catalog.to_jsonb(r);
end $$;
create function public.settle_bot_outbound(p_outbound_id uuid,p_fence bigint,p_attempt_id uuid,p_outcome jsonb) returns boolean
language plpgsql security invoker set search_path='' as $$
declare r public.bot_outbound%rowtype; k text; code text; v_delay integer;
begin
 select * into r from public.bot_outbound where id=p_outbound_id for update;
 if not found then return false; end if;
 if r.state='accepted' and r.provider_message_id is not null then return true; end if;
 if r.state<>'sending' or r.fence<>p_fence or r.attempt_id<>p_attempt_id then return false; end if;
 k=p_outcome->>'kind';
 if k='accepted' and pg_catalog.jsonb_typeof(p_outcome->'providerMessageId')='string' and pg_catalog.length(p_outcome->>'providerMessageId') between 1 and 512 then
  update public.bot_outbound set state='accepted',provider_message_id=p_outcome->>'providerMessageId',lease_until=null,diagnostic_code=null where id=r.id;
  if r.batch_id is not null then insert into public.bot_receipt_ids(gateway,message_id,batch_id) values(r.gateway,p_outcome->>'providerMessageId',r.batch_id); end if;
  if r.pending_id is not null and r.expires_at>clock_timestamp() then
   update public.pending_actions set confirmation_message_id=p_outcome->>'providerMessageId'
    where id=r.pending_id and account_id=r.account_id and wa_chat_id=r.destination and expires_at>clock_timestamp();
  end if;
  if r.kind='help' and r.account_id is not null then
   insert into public.bot_help_context(gateway,provider_message_id,account_id,chat_id,expires_at)
    values(r.gateway,p_outcome->>'providerMessageId',r.account_id,r.destination,clock_timestamp()+interval '15 minutes') on conflict do nothing;
  end if;
  return true;
 elsif k='rejected' and pg_catalog.jsonb_typeof(p_outcome->'retryable')='boolean' and pg_catalog.jsonb_typeof(p_outcome->'code')='string' and p_outcome->>'code' ~ '^[a-z0-9_]{1,64}$' then
  code=p_outcome->>'code';
  if (p_outcome->>'retryable')::boolean and r.attempt<5 and (r.expires_at is null or r.expires_at>clock_timestamp()) then
   v_delay=case when pg_catalog.jsonb_typeof(p_outcome->'retryAfterSeconds')='number' and (p_outcome->>'retryAfterSeconds')::numeric between 1 and 3600 then (p_outcome->>'retryAfterSeconds')::integer else null end;
   update public.bot_outbound set state='rejected',retryable=true,diagnostic_code=code,lease_until=null,next_attempt_at=clock_timestamp()+
    case when v_delay is not null then pg_catalog.make_interval(secs=>v_delay) else case r.attempt when 1 then interval '5 seconds' when 2 then interval '30 seconds' when 3 then interval '2 minutes' else interval '10 minutes' end end where id=r.id;
  else update public.bot_outbound set state='rejected',retryable=false,diagnostic_code=code,lease_until=null where id=r.id; end if;
  return true;
 elsif k='uncertain' and pg_catalog.jsonb_typeof(p_outcome->'code')='string' and p_outcome->>'code' ~ '^[a-z0-9_]{1,64}$' then
  update public.bot_outbound set state='uncertain',retryable=false,diagnostic_code=p_outcome->>'code',lease_until=null where id=r.id;return true;
 end if;
 return false;
end $$;
create function public.recover_bot_outbound(p_outbound_id uuid,p_action text,p_argument text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare r public.bot_outbound%rowtype;
begin
 select * into r from public.bot_outbound where id=p_outbound_id for update;
 if not found then return pg_catalog.jsonb_build_object('ok',false,'code','missing'); end if;
 if p_action='show' then
  insert into public.bot_delivery_audit(outbound_id,action,result_code) values(r.id,'show',r.state);
  return pg_catalog.jsonb_build_object('ok',true,'id',r.id,'state',r.state,'attempt',r.attempt,
   'diagnosticCode',r.diagnostic_code,'kind',r.kind,'gateway',r.gateway,'accountId',r.account_id);
 end if;
 if p_action='resume' and r.state in ('pending','rejected') and (r.expires_at is null or r.expires_at>clock_timestamp()) then
  insert into public.bot_delivery_audit(outbound_id,action,result_code) values(r.id,'resume','queued');
  update public.bot_outbound set state='pending',attempt=0,next_attempt_at=clock_timestamp(),retryable=false where id=r.id;
  return pg_catalog.jsonb_build_object('ok',true,'code','queued');
 end if;
 if p_action='bind-id' and r.state='accepted' and r.provider_message_id=p_argument then return pg_catalog.jsonb_build_object('ok',true,'code','accepted'); end if;
 if p_action='bind-id' and r.state='uncertain' and p_argument ~ '^[^[:space:]]{1,512}$' and (r.expires_at is null or r.expires_at>clock_timestamp()) then
  update public.bot_outbound set state='accepted',provider_message_id=p_argument,diagnostic_code=null where id=r.id;
  insert into public.bot_delivery_audit(outbound_id,action,result_code) values(r.id,'bind-id','accepted');
  if r.batch_id is not null then insert into public.bot_receipt_ids(gateway,message_id,batch_id) values(r.gateway,p_argument,r.batch_id); end if;
  if r.pending_id is not null then
   update public.pending_actions set confirmation_message_id=p_argument where id=r.pending_id and account_id=r.account_id
    and wa_chat_id=r.destination and expires_at>clock_timestamp();
  end if;
  if r.kind='help' and r.account_id is not null then
   insert into public.bot_help_context(gateway,provider_message_id,account_id,chat_id,expires_at)
    values(r.gateway,p_argument,r.account_id,r.destination,clock_timestamp()+interval '15 minutes') on conflict do nothing;
  end if;
  return pg_catalog.jsonb_build_object('ok',true,'code','accepted');
 end if;
 if p_action='resend-uncertain' and p_argument='acknowledge-duplicate-risk' and r.state='uncertain' and (r.expires_at is null or r.expires_at>clock_timestamp()) then
  update public.bot_outbound set state='pending',attempt=0,next_attempt_at=clock_timestamp(),diagnostic_code='operator_resend_acknowledged' where id=r.id;
  insert into public.bot_delivery_audit(outbound_id,action,result_code) values(r.id,p_action,'queued');
  return pg_catalog.jsonb_build_object('ok',true,'code','queued');
 end if;
 if p_action='resolve' and r.state='uncertain' and p_argument in ('rejected','discard') then
  update public.bot_outbound set state='resolved',diagnostic_code='operator_resolved_'||p_argument where id=r.id;
  insert into public.bot_delivery_audit(outbound_id,action,result_code) values(r.id,p_action,p_argument);
  return pg_catalog.jsonb_build_object('ok',true,'code',p_argument);
 end if;
 return pg_catalog.jsonb_build_object('ok',false,'code','invalid_transition');
end $$;
create function public.claim_bot_recovery_work(p_inbox_limit integer,p_outbound_limit integer,p_wake_delay_seconds integer) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare inbox_ids jsonb='[]'; outbound_ids jsonb='[]'; v_now timestamptz=pg_catalog.clock_timestamp();
begin
 if p_inbox_limit is null or p_inbox_limit not between 1 and 50 or
    p_outbound_limit is null or p_outbound_limit not between 1 and 50 or
    p_wake_delay_seconds is null or p_wake_delay_seconds not between 1 and 300 then
  raise exception 'Invalid recovery bounds';
 end if;
 with stale as (
  select id from public.bot_outbound where state='sending' and lease_until<=v_now
   order by lease_until for update skip locked limit p_outbound_limit
 )
 update public.bot_outbound o set state='uncertain',retryable=false,diagnostic_code='interrupted_send',lease_until=null
  from stale where o.id=stale.id;
 with exhausted as (
  select id from public.bot_inbox where state='processing' and lease_until<=v_now and attempt>=5
   order by lease_until for update skip locked limit p_inbox_limit
 )
 update public.bot_inbox i set state='failed',lease_until=null,diagnostic_code='attempts_exhausted',terminal_at=v_now
  from exhausted where i.id=exhausted.id;
 with due as (
  select id from public.bot_inbox
   where (state='pending' or (state='processing' and lease_until<=v_now))
    and attempt<5 and next_attempt_at<=v_now and next_wake_at<=v_now
   order by next_attempt_at,receipt_order for update skip locked limit p_inbox_limit
 ), touched as (
  update public.bot_inbox i set next_wake_at=v_now+pg_catalog.make_interval(secs=>p_wake_delay_seconds)
   from due where i.id=due.id returning i.id
 )
 select coalesce(pg_catalog.jsonb_agg(id),'[]'::jsonb) into inbox_ids from touched;
 with invalid as (
  select o.id,case when o.expires_at<=v_now then 'expired' else 'access_changed' end as code
  from public.bot_outbound o left join public.accounts a on a.id=o.account_id and a.is_active and a.wa_chat_id=o.destination
  where o.state in ('pending','rejected') and
   ((o.expires_at is not null and o.expires_at<=v_now) or (o.account_id is not null and a.id is null))
  order by o.created_at for update of o skip locked limit p_outbound_limit
 )
 update public.bot_outbound o set state='resolved',retryable=false,diagnostic_code=invalid.code
  from invalid where o.id=invalid.id;
 with due as (
  select id from public.bot_outbound
   where (state='pending' or (state='rejected' and retryable))
    and attempt<5 and next_attempt_at<=v_now and next_wake_at<=v_now
    and (expires_at is null or expires_at>v_now)
    and (account_id is null or exists(select 1 from public.accounts a where a.id=account_id and a.is_active and a.wa_chat_id=destination))
   order by next_attempt_at,created_at for update skip locked limit p_outbound_limit
 ), touched as (
  update public.bot_outbound o set next_wake_at=v_now+pg_catalog.make_interval(secs=>p_wake_delay_seconds)
   from due where o.id=due.id returning o.id
 )
 select coalesce(pg_catalog.jsonb_agg(id),'[]'::jsonb) into outbound_ids from touched;
 return pg_catalog.jsonb_build_object('inboxIds',inbox_ids,'outboundIds',outbound_ids);
end $$;
revoke all on function public.claim_bot_recovery_work(integer,integer,integer) from public,anon,authenticated;
grant execute on function public.claim_bot_recovery_work(integer,integer,integer) to service_role;
revoke all on function public.freeze_bot_reply(uuid,text),public.claim_bot_outbound(uuid),public.settle_bot_outbound(uuid,bigint,uuid,jsonb),public.recover_bot_outbound(uuid,text,text) from public,anon,authenticated;
grant execute on function public.freeze_bot_reply(uuid,text),public.claim_bot_outbound(uuid),public.settle_bot_outbound(uuid,bigint,uuid,jsonb),public.recover_bot_outbound(uuid,text,text) to service_role;
commit;
