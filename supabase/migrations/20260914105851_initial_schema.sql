create extension if not exists pgcrypto;

create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 1 and 200),
  created_at timestamptz not null default now()
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  sku text not null check (char_length(trim(sku)) between 1 and 80),
  name text not null check (char_length(trim(name)) between 1 and 200),
  description text,
  unit text not null check (char_length(trim(unit)) between 1 and 40),
  price numeric(14,2) not null check (price >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, sku),
  unique (company_id, id)
);

create index if not exists products_company_active_name_idx
  on public.products (company_id, active, name);

create table if not exists public.inventory (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  product_id uuid not null,
  quantity numeric(14,3) not null check (quantity >= 0),
  updated_at timestamptz not null default now(),
  unique (company_id, product_id),
  foreign key (company_id, product_id)
    references public.products(company_id, id)
    on delete cascade
);

create index if not exists inventory_product_idx
  on public.inventory (product_id);

create table if not exists public.unit_conversions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  product_id uuid null,
  from_unit text not null check (char_length(trim(from_unit)) between 1 and 40),
  to_unit text not null check (char_length(trim(to_unit)) between 1 and 40),
  factor numeric(18,6) not null check (factor > 0),
  created_at timestamptz not null default now(),
  foreign key (company_id, product_id)
    references public.products(company_id, id)
    on delete cascade
);

create unique index if not exists unit_conversions_unique_scope_idx
  on public.unit_conversions (
    company_id,
    coalesce(product_id, '00000000-0000-0000-0000-000000000000'::uuid),
    from_unit,
    to_unit
  );

create index if not exists unit_conversions_lookup_idx
  on public.unit_conversions (company_id, product_id, from_unit, to_unit);

create table if not exists public.payment_accounts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  bank_name text not null check (char_length(trim(bank_name)) between 1 and 120),
  account_number text not null check (char_length(trim(account_number)) between 5 and 64),
  account_name text not null check (char_length(trim(account_name)) between 1 and 160),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (company_id, account_number)
);

create index if not exists payment_accounts_company_active_idx
  on public.payment_accounts (company_id, active, created_at);

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  session_id text not null check (char_length(trim(session_id)) between 1 and 160),
  state jsonb not null default '{}'::jsonb,
  ownership text not null default 'AI_ACTIVE' check (
    ownership in ('AI_ACTIVE', 'HUMAN_PENDING', 'HUMAN_ACTIVE', 'CLOSED')
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, session_id)
);

create index if not exists conversations_company_ownership_updated_idx
  on public.conversations (company_id, ownership, updated_at desc);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system', 'tool')),
  sender text not null default 'SYSTEM' check (sender in ('CUSTOMER', 'AI', 'ADMIN', 'SYSTEM')),
  content text not null check (char_length(content) between 1 and 10000),
  created_at timestamptz not null default now()
);

create index if not exists messages_conversation_created_idx
  on public.messages (conversation_id, created_at);

create table if not exists public.human_handoffs (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  reason text not null check (char_length(trim(reason)) between 1 and 240),
  reason_code text not null default 'OTHER' check (
    reason_code in (
      'AI_UNCERTAIN',
      'CUSTOMER_REQUESTED_HUMAN',
      'PRODUCT_AMBIGUOUS_UNRESOLVED',
      'SPECIAL_PRICE_REQUEST',
      'DISCOUNT_REQUEST',
      'DELIVERY_UNVERIFIED',
      'PAYMENT_ISSUE',
      'PAYMENT_VERIFICATION',
      'COMPLAINT',
      'ORDER_EXCEPTION',
      'BUSINESS_DATA_UNAVAILABLE',
      'UNSAFE_RESPONSE_BLOCKED',
      'OUT_OF_SCOPE',
      'OTHER'
    )
  ),
  summary text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  status text not null default 'PENDING' check (
    status in ('PENDING', 'ACTIVE', 'RESOLVED', 'CLOSED')
  ),
  created_at timestamptz not null default now(),
  claimed_at timestamptz null,
  resolved_at timestamptz null
);

create unique index if not exists human_handoffs_one_open_per_conversation_idx
  on public.human_handoffs (conversation_id)
  where status in ('PENDING', 'ACTIVE');

create index if not exists human_handoffs_status_created_idx
  on public.human_handoffs (status, created_at desc);

alter table public.companies enable row level security;
alter table public.products enable row level security;
alter table public.inventory enable row level security;
alter table public.unit_conversions enable row level security;
alter table public.payment_accounts enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.human_handoffs enable row level security;

revoke all on table public.companies from anon, authenticated;
revoke all on table public.products from anon, authenticated;
revoke all on table public.inventory from anon, authenticated;
revoke all on table public.unit_conversions from anon, authenticated;
revoke all on table public.payment_accounts from anon, authenticated;
revoke all on table public.conversations from anon, authenticated;
revoke all on table public.messages from anon, authenticated;
revoke all on table public.human_handoffs from anon, authenticated;

grant all on table public.companies to service_role;
grant all on table public.products to service_role;
grant all on table public.inventory to service_role;
grant all on table public.unit_conversions to service_role;
grant all on table public.payment_accounts to service_role;
grant all on table public.conversations to service_role;
grant all on table public.messages to service_role;
grant all on table public.human_handoffs to service_role;
