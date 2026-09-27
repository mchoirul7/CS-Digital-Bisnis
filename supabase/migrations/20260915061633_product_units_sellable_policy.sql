-- Satuan jual per produk beserta aturan "satuan mana yang boleh dijual".
-- Migrasi order (20260920) memakai tabel ini, jadi tabelnya lahir di sini.
begin;

-- Dibutuhkan foreign key (company_id, product_id) di bawah; migrasi order
-- membuat index yang sama secara idempoten.
create unique index if not exists products_company_id_id_order_key on public.products(company_id, id);

-- unit_code is the existing application contract; products.unit remains the base.
create table if not exists public.product_units (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  product_id uuid not null,
  unit_code text not null check (length(trim(unit_code)) between 1 and 40),
  conversion_to_base numeric(18,6) not null check (conversion_to_base > 0 and conversion_to_base::text not in ('NaN','Infinity')),
  selling_price numeric(14,2) check (selling_price >= 0 and selling_price::text not in ('NaN','Infinity')),
  is_base_unit boolean not null default false,
  is_sellable boolean not null default true,
  min_quantity numeric(18,6) not null default 1 check(min_quantity > 0),
  quantity_step numeric(18,6) not null default 1 check(quantity_step > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(product_id, unit_code),
  foreign key(company_id, product_id) references public.products(company_id,id),
  check(not is_base_unit or conversion_to_base=1)
);
create unique index if not exists product_units_one_base_idx on public.product_units(product_id) where is_base_unit;
create index if not exists product_units_company_product_idx on public.product_units(company_id,product_id);
insert into public.product_units(company_id,product_id,unit_code,conversion_to_base,is_base_unit)
  select company_id,id,unit,1,true from public.products
  on conflict(product_id,unit_code) do nothing;

-- Aturan sellable: satuan dasar adalah cadangan terakhir untuk harga
-- (confirm_order memakai products.price * conversion_to_base saat
-- selling_price kosong) sekaligus satuan penyimpanan stok. Menariknya dari
-- peredaran akan membuat produk mustahil dipesan dalam satuan apa pun,
-- karena itu satuan dasar wajib tetap bisa dijual. Aturan ini sekaligus
-- menjamin setiap produk selalu punya minimal satu satuan jual.
do $$ begin
  if not exists (select 1 from pg_constraint where conname='product_units_base_unit_sellable') then
    alter table public.product_units add constraint product_units_base_unit_sellable
      check (is_sellable or not is_base_unit);
  end if;
end $$;

commit;
