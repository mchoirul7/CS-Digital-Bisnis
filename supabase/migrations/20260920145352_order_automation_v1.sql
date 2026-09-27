-- Apply in one transaction. Renaming preserves every existing stock value.
begin;

create unique index if not exists products_company_id_id_order_key on public.products(company_id, id);
create unique index if not exists conversations_company_id_id_order_key on public.conversations(company_id, id);
alter table public.conversations add column if not exists state_version integer not null default 0;

do $$
begin
  if exists (select 1 from public.inventory where quantity is null or quantity < 0 or quantity::text in ('NaN','Infinity','-Infinity')) then
    raise exception 'Inventory preflight failed: repair invalid quantities before migration';
  end if;
  if exists (select 1 from public.inventory i left join public.products p on p.id=i.product_id and p.company_id=i.company_id where p.id is null) then
    raise exception 'Inventory preflight failed: cross-company product';
  end if;
end $$;
alter table public.inventory rename column quantity to quantity_on_hand;
alter table public.inventory add column quantity_reserved numeric(18,6) not null default 0;
alter table public.inventory alter column quantity_on_hand type numeric(18,6);
alter table public.inventory add constraint inventory_reservation_valid check (
  quantity_reserved >= 0 and quantity_reserved <= quantity_on_hand
  and quantity_on_hand::text not in ('NaN','Infinity','-Infinity')
);
alter table public.inventory add constraint inventory_order_tenant_fk foreign key(company_id, product_id)
  references public.products(company_id, id);
create view public.inventory_legacy with (security_invoker=true) as
  select id, company_id, product_id, quantity_on_hand - quantity_reserved as quantity, updated_at from public.inventory;
revoke all on public.inventory_legacy from public, anon, authenticated;
grant select on public.inventory_legacy to service_role;

create or replace function public.order_touch_updated_at() returns trigger
language plpgsql security invoker set search_path='' as $$
begin new.updated_at=now(); return new; end $$;

-- product_units dan aturan sellable-nya dibuat di migrasi 20260915061633.

create or replace function public.order_sync_base_unit() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if TG_OP='UPDATE' and new.unit is distinct from old.unit then
    raise exception 'BASE_UNIT_CHANGE_REQUIRES_STOCK_MIGRATION';
  end if;
  insert into public.product_units(company_id,product_id,unit_code,conversion_to_base,is_base_unit)
    values(new.company_id,new.id,new.unit,1,true) on conflict(product_id,unit_code) do nothing;
  return new;
end $$;
create trigger order_product_base_unit after insert or update of unit on public.products
for each row execute function public.order_sync_base_unit();

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  name text,
  phone text check(phone is null or phone ~ '^\+[1-9][0-9]{7,14}$'),
  customer_code text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(company_id,id), unique(company_id,phone), unique(company_id,customer_code)
);

create sequence public.order_number_seq;
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  customer_id uuid,
  conversation_id uuid,
  checkout_key uuid not null,
  order_number text not null default ('ORD-' || to_char(now() at time zone 'Asia/Jakarta','YYYYMMDD') || '-' || lpad(nextval('public.order_number_seq')::text,10,'0')),
  status text not null default 'draft' check(status in ('draft','confirmed','processing','completed','cancelled')),
  subtotal numeric(18,2) not null default 0 check(subtotal >= 0 and subtotal::text not in ('NaN','Infinity')),
  discount numeric(18,2) not null default 0 check(discount >= 0 and discount <= subtotal),
  total numeric(18,2) not null default 0 check(total = subtotal-discount),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  unique(company_id,id), unique(company_id,order_number), unique(company_id,checkout_key),
  foreign key(company_id,customer_id) references public.customers(company_id,id),
  foreign key(company_id,conversation_id) references public.conversations(company_id,id)
);
create index orders_company_status_created_idx on public.orders(company_id,status,created_at desc);
create index orders_customer_idx on public.orders(company_id,customer_id);
create index orders_conversation_idx on public.orders(company_id,conversation_id);

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  order_id uuid not null,
  product_id uuid not null,
  product_name text not null,
  quantity numeric(18,6) not null check(quantity > 0 and quantity::text not in ('NaN','Infinity')),
  unit text not null,
  unit_price numeric(14,2) not null check(unit_price >= 0 and unit_price::text not in ('NaN','Infinity')),
  subtotal numeric(18,2) not null check(subtotal=round(quantity*unit_price,2)),
  conversion_to_base numeric(18,6) not null check(conversion_to_base > 0 and conversion_to_base::text not in ('NaN','Infinity')),
  base_quantity numeric(18,6) not null check(base_quantity=quantity*conversion_to_base),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key(company_id,order_id) references public.orders(company_id,id),
  foreign key(company_id,product_id) references public.products(company_id,id),
  unique(order_id,product_id,unit)
);
create index order_items_product_idx on public.order_items(company_id,product_id);

create table public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  product_id uuid not null,
  type text not null check(type in ('purchase','sale','adjustment','reservation','release','cancellation')),
  quantity numeric(18,6) not null check(quantity <> 0 and quantity::text not in ('NaN','Infinity','-Infinity')),
  reference_type text,
  reference_id uuid,
  notes text,
  created_at timestamptz not null default now(),
  foreign key(company_id,product_id) references public.products(company_id,id)
);
create index inventory_movements_product_created_idx on public.inventory_movements(company_id,product_id,created_at desc);
create index inventory_movements_reference_idx on public.inventory_movements(company_id,reference_id);

-- These audit tables exist on the connected database but were absent from migrations.
create table if not exists public.tool_calls (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references public.conversations(id),
  tool_name text not null, arguments jsonb not null default '{}', result jsonb,
  success boolean not null default true, error_message text, created_at timestamptz not null default now()
);
create table if not exists public.business_guard_logs (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references public.conversations(id),
  guard_type text not null, candidate_response text, action text not null check(action in ('allowed','blocked')),
  reason text, metadata jsonb not null default '{}', created_at timestamptz not null default now()
);
alter table public.tool_calls add column if not exists company_id uuid references public.companies(id);
alter table public.business_guard_logs add column if not exists company_id uuid references public.companies(id);
update public.tool_calls a set company_id=c.company_id from public.conversations c where a.conversation_id=c.id and a.company_id is null;
update public.business_guard_logs a set company_id=c.company_id from public.conversations c where a.conversation_id=c.id and a.company_id is null;
alter table public.tool_calls add constraint tool_calls_tenant_fk foreign key(company_id,conversation_id) references public.conversations(company_id,id);
alter table public.business_guard_logs add constraint guard_logs_tenant_fk foreign key(company_id,conversation_id) references public.conversations(company_id,id);
create index if not exists tool_calls_company_conversation_idx on public.tool_calls(company_id,conversation_id,created_at);
create index if not exists guard_logs_company_conversation_idx on public.business_guard_logs(company_id,conversation_id,created_at);

-- One RPC is one transaction. Lock conversation first, then products/inventory in UUID order.
create function public.confirm_order(p_company_id uuid,p_conversation_id uuid,p_checkout_key uuid,p_phone text default null)
returns uuid language plpgsql security invoker set search_path='' as $$
declare
  v_conversation public.conversations%rowtype;
  v_order public.orders%rowtype;
  v_product public.products%rowtype;
  v_unit public.product_units%rowtype;
  v_stock public.inventory%rowtype;
  v_item jsonb;
  v_items jsonb;
  v_quantity numeric;
  v_base numeric;
  v_price numeric;
  v_customer uuid;
  v_total numeric := 0;
begin
  select * into v_conversation from public.conversations where company_id=p_company_id and id=p_conversation_id for update;
  if not found then raise exception 'CONVERSATION_NOT_FOUND'; end if;
  select * into v_order from public.orders where company_id=p_company_id and conversation_id=p_conversation_id and checkout_key=p_checkout_key;
  if found then
    insert into public.business_guard_logs(company_id,conversation_id,guard_type,action,reason)
      values(p_company_id,p_conversation_id,'duplicate_confirmation','blocked','ORDER_ALREADY_CONFIRMED');
    return v_order.id;
  end if;
  if v_conversation.ownership not in ('AI_ACTIVE','HUMAN_PENDING') then raise exception 'CONVERSATION_NOT_AI_ACTIVE'; end if;
  if (v_conversation.state->'checkout'->>'key')::uuid is distinct from p_checkout_key
    or coalesce((v_conversation.state->>'awaitingConfirmation')::boolean,false)=false then
    raise exception 'CONFIRMATION_REVIEW_REQUIRED';
  end if;
  v_items := v_conversation.state->'checkout'->'items';
  if jsonb_typeof(v_items) is distinct from 'array' or jsonb_array_length(v_items) not between 1 and 50 then raise exception 'INVALID_DRAFT'; end if;
  if exists(select 1 from jsonb_array_elements(v_items) x group by x->>'product_id',x->>'unit' having count(*)>1) then raise exception 'DUPLICATE_ITEM'; end if;

  if p_phone is not null then
    insert into public.customers(company_id,phone) values(p_company_id,p_phone)
      on conflict(company_id,phone) do update set updated_at=now() returning id into v_customer;
    if not (select active from public.customers where id=v_customer) then raise exception 'CUSTOMER_INACTIVE'; end if;
  end if;
  insert into public.orders(company_id,customer_id,conversation_id,checkout_key,status,confirmed_at)
    values(p_company_id,v_customer,p_conversation_id,p_checkout_key,'confirmed',now()) returning * into v_order;

  for v_item in select value from jsonb_array_elements(v_items) order by value->>'product_id',value->>'unit' loop
    select * into v_product from public.products where company_id=p_company_id and id=(v_item->>'product_id')::uuid for share;
    if not found or not v_product.active then raise exception 'PRODUCT_INACTIVE'; end if;
    select * into v_unit from public.product_units where company_id=p_company_id and product_id=v_product.id and unit_code=v_item->>'unit' for share;
    if not found or not v_unit.is_sellable then raise exception 'UNKNOWN_UNIT'; end if;
    if v_unit.conversion_to_base <= 0 or v_unit.conversion_to_base::text in ('NaN','Infinity') then raise exception 'INVALID_CONVERSION'; end if;
    v_quantity := (v_item->>'quantity')::numeric;
    if v_quantity is null or v_quantity <= 0 or v_quantity::text in ('NaN','Infinity','-Infinity')
      or v_quantity < v_unit.min_quantity or mod(v_quantity-v_unit.min_quantity,v_unit.quantity_step) <> 0 then raise exception 'INVALID_QUANTITY'; end if;
    v_price := coalesce(v_unit.selling_price,round(v_product.price*v_unit.conversion_to_base,2));
    if v_price is null or v_price < 0 or v_price::text in ('NaN','Infinity') then raise exception 'PRICE_UNAVAILABLE'; end if;
    if v_price is distinct from (v_item->>'unit_price')::numeric
      or v_unit.conversion_to_base is distinct from (v_item->>'conversion_to_base')::numeric then raise exception 'QUOTE_CHANGED'; end if;
    v_base := v_quantity*v_unit.conversion_to_base;
    select * into v_stock from public.inventory where company_id=p_company_id and product_id=v_product.id for update;
    if not found or v_stock.quantity_on_hand-v_stock.quantity_reserved < v_base then raise exception 'INSUFFICIENT_STOCK'; end if;
    update public.inventory set quantity_reserved=quantity_reserved+v_base,updated_at=now() where id=v_stock.id;
    insert into public.order_items(company_id,order_id,product_id,product_name,quantity,unit,unit_price,subtotal,conversion_to_base,base_quantity)
      values(p_company_id,v_order.id,v_product.id,v_product.name,v_quantity,v_unit.unit_code,v_price,round(v_quantity*v_price,2),v_unit.conversion_to_base,v_base);
    insert into public.inventory_movements(company_id,product_id,type,quantity,reference_type,reference_id)
      values(p_company_id,v_product.id,'reservation',v_base,'order',v_order.id);
    v_total := v_total+round(v_quantity*v_price,2);
  end loop;
  update public.orders set subtotal=v_total,total=v_total where id=v_order.id;
  update public.conversations set state=(state - array['draftItems','checkout','pendingOperation','pendingIntent','pendingQuantity','pendingUnit','pendingCandidates','awaitingClarification'])
    || jsonb_build_object('awaitingConfirmation',false,'lastOrderId',v_order.id,'lastCheckoutKey',p_checkout_key,'orderPhase','PAYMENT'),
    state_version=state_version+1,updated_at=now() where id=p_conversation_id;
  return v_order.id;
end $$;

create function public.change_order_status(p_company_id uuid,p_order_id uuid,p_status text)
returns uuid language plpgsql security invoker set search_path='' as $$
declare v_order public.orders%rowtype; v_item record;
begin
  select * into v_order from public.orders where company_id=p_company_id and id=p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if p_status=v_order.status then return v_order.id; end if;
  if p_status is null or not (
    (v_order.status='draft' and p_status='cancelled') or
    (v_order.status='confirmed' and p_status in ('processing','completed','cancelled')) or
    (v_order.status='processing' and p_status in ('completed','cancelled'))
  ) then raise exception 'INVALID_ORDER_TRANSITION'; end if;
  if p_status in ('completed','cancelled') and v_order.status<>'draft' then
    for v_item in select product_id,sum(base_quantity) as quantity from public.order_items
      where company_id=p_company_id and order_id=p_order_id group by product_id order by product_id loop
      perform 1 from public.inventory where company_id=p_company_id and product_id=v_item.product_id for update;
      update public.inventory set quantity_reserved=quantity_reserved-v_item.quantity,
        quantity_on_hand=quantity_on_hand-case when p_status='completed' then v_item.quantity else 0 end,updated_at=now()
        where company_id=p_company_id and product_id=v_item.product_id and quantity_reserved>=v_item.quantity;
      if not found then raise exception 'RESERVATION_INCONSISTENT'; end if;
      insert into public.inventory_movements(company_id,product_id,type,quantity,reference_type,reference_id)
        values(p_company_id,v_item.product_id,case when p_status='completed' then 'sale' else 'release' end,v_item.quantity,'order',p_order_id);
    end loop;
  end if;
  update public.orders set status=p_status,cancelled_at=case when p_status='cancelled' then now() else cancelled_at end where id=p_order_id;
  return p_order_id;
end $$;

do $$ declare t text; begin
  foreach t in array array['customers','orders','order_items','product_units','inventory_movements','tool_calls','business_guard_logs'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public, anon, authenticated',t);
    execute format('grant all on public.%I to service_role',t);
  end loop;
  foreach t in array array['customers','orders','order_items','product_units'] loop
    execute format('create trigger order_updated_at before update on public.%I for each row execute function public.order_touch_updated_at()',t);
  end loop;
end $$;
revoke all on sequence public.order_number_seq from public,anon,authenticated;
grant usage,select on sequence public.order_number_seq to service_role;
revoke all on function public.confirm_order(uuid,uuid,uuid,text), public.change_order_status(uuid,uuid,text), public.order_touch_updated_at(), public.order_sync_base_unit() from public,anon,authenticated;
grant execute on function public.confirm_order(uuid,uuid,uuid,text), public.change_order_status(uuid,uuid,text), public.order_touch_updated_at(), public.order_sync_base_unit() to service_role;
commit;
