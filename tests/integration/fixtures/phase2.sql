do $$ begin
 if not exists(select 1 from pg_catalog.pg_roles where rolname='service_role') then create role service_role nologin; end if;
 if not exists(select 1 from pg_catalog.pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
 if not exists(select 1 from pg_catalog.pg_roles where rolname='anon') then create role anon nologin; end if;
end $$;
create schema auth;
create table auth.users(id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable set search_path='' as $$
 select nullif(pg_catalog.current_setting('request.jwt.claim.sub',true),'')::uuid
$$;
create table public.accounts (
 id uuid primary key default gen_random_uuid(), name text not null,
 type text not null default 'personal' check(type in ('personal','group')),
 owner_id uuid not null references auth.users(id), wa_chat_id text unique,
 language text not null default 'id', is_active boolean not null default true,
 created_at timestamptz not null default now()
);
create table public.members (
 id uuid primary key default gen_random_uuid(), account_id uuid not null references public.accounts(id),
 user_id uuid references auth.users(id), wa_phone text, role text not null default 'member',
 display_name text, language_pref text, created_at timestamptz not null default now(),
 unique(account_id,user_id), unique(account_id,wa_phone)
);
create table public.categories (
 id uuid primary key default gen_random_uuid(), account_id uuid not null references public.accounts(id),
 name text not null, type text not null check(type in ('income','expense')),
 is_custom boolean not null default false, is_active boolean not null default true,
 sort_order integer not null default 0, created_at timestamptz not null default now()
);
create table public.transactions (
 id uuid primary key default gen_random_uuid(), account_id uuid not null references public.accounts(id),
 category_id uuid references public.categories(id), amount numeric(15,2) not null check(amount>0),
 type text not null check(type in ('income','expense')), description text,
 date date not null, raw_message text, wa_user_message_id text, wa_bot_message_id text,
 recorded_by_name text, recorded_by_phone text, edited_by_name text,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.pending_actions (
 id uuid primary key default gen_random_uuid(), account_id uuid not null references public.accounts(id),
 transaction_id uuid references public.transactions(id), action text not null,
 expires_at timestamptz not null, created_at timestamptz not null default now()
);
create table public.link_codes (
 id uuid primary key default gen_random_uuid(), account_id uuid not null references public.accounts(id),
 code text not null unique, used boolean not null default false,
 expires_at timestamptz not null, created_at timestamptz not null default now()
);
create table public.invite_tokens (
 id uuid primary key default gen_random_uuid(), account_id uuid not null references public.accounts(id),
 token text not null unique, used boolean not null default false,
 expires_at timestamptz not null, created_at timestamptz not null default now()
);
create table public.budgets (
 id uuid primary key default gen_random_uuid(), account_id uuid not null references public.accounts(id),
 category_id uuid not null references public.categories(id), amount numeric(15,2) not null check(amount>0),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(account_id,category_id)
);
grant usage on schema public,auth to service_role;
grant select,insert,update,delete on all tables in schema public,auth to service_role;
