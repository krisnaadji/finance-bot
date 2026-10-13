create extension if not exists pgcrypto;
do $$ begin
 if not exists (select 1 from pg_roles where rolname='service_role') then
  create role service_role nologin;
 end if;
 if not exists (select 1 from pg_roles where rolname='authenticated') then
  create role authenticated nologin;
 end if;
 if not exists (select 1 from pg_roles where rolname='anon') then
  create role anon nologin;
 end if;
end $$;
create table public.accounts (
 id uuid primary key default gen_random_uuid(), name text not null,
 owner_id uuid, wa_chat_id text, is_active boolean default true
);
create table public.transactions (
 id uuid primary key default gen_random_uuid(), account_id uuid references public.accounts(id),
 amount numeric(15,2) not null, type text not null, date date not null,
 description text, updated_at timestamptz default now()
);
create table public.pending_actions (
 id uuid primary key default gen_random_uuid(), account_id uuid references public.accounts(id),
 transaction_id uuid references public.transactions(id), action text not null,
 expires_at timestamptz not null, created_at timestamptz default now()
);
grant usage on schema public to service_role;
grant select, insert, update, delete on public.accounts, public.transactions, public.pending_actions to service_role;
