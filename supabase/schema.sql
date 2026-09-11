create extension if not exists pgcrypto;

create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (length(trim(name)) > 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.payment_methods (
  code text primary key check (code in ('cash','transfer','card','other')),
  name text not null unique,
  active boolean not null default true,
  sort_order smallint not null default 0
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  price numeric(12,2) not null check (price >= 0),
  category_id uuid references public.categories(id) on delete set null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique,
  sold_at timestamptz not null default now(),
  person_name text not null check (length(trim(person_name)) > 0),
  person_name_normalized text generated always as
    (lower(regexp_replace(trim(person_name), '\s+', ' ', 'g'))) stored,
  payment_method text not null references public.payment_methods(code),
  total numeric(12,2) not null check (total >= 0),
  amount_received numeric(12,2) not null check (amount_received >= 0),
  change_amount numeric(12,2) not null default 0 check (change_amount >= 0),
  notes text check (notes is null or length(notes) <= 500),
  status text not null default 'completed' check (status in ('completed','voided')),
  idempotency_key uuid not null unique,
  created_at timestamptz not null default now(),
  constraint cash_received_enough check (payment_method <> 'cash' or amount_received >= total),
  constraint non_cash_no_change check (payment_method = 'cash' or change_amount = 0)
);

create table if not exists public.invoice_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete restrict,
  product_id uuid references public.products(id) on delete set null,
  product_name text not null check (length(trim(product_name)) > 0),
  quantity integer not null check (quantity > 0),
  unit_price numeric(12,2) not null check (unit_price >= 0),
  line_total numeric(12,2) generated always as (quantity * unit_price) stored,
  created_at timestamptz not null default now()
);

create table if not exists public.invoice_voids (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null unique references public.invoices(id) on delete restrict,
  reason text not null check (length(trim(reason)) > 0 and length(reason) <= 300),
  voided_at timestamptz not null default now()
);

create table if not exists public.business_settings (
  id boolean primary key default true check (id = true),
  business_name text not null default 'London Frozen and Hot',
  currency_code char(3) not null default 'USD' check (currency_code = 'USD'),
  timezone text not null default 'America/Guayaquil' check (timezone = 'America/Guayaquil'),
  order_prefix text not null default 'LFH' check (length(trim(order_prefix)) > 0),
  updated_at timestamptz not null default now()
);

create index if not exists products_active_name_idx on public.products(active, lower(name));
create index if not exists products_category_idx on public.products(category_id);
create index if not exists invoices_sold_at_idx on public.invoices(sold_at desc);
create index if not exists invoices_status_date_idx on public.invoices(status, sold_at desc);
create index if not exists invoices_person_idx on public.invoices(person_name_normalized);
create index if not exists invoices_payment_idx on public.invoices(payment_method, sold_at desc);
create index if not exists invoice_items_invoice_idx on public.invoice_items(invoice_id);
create index if not exists invoice_items_product_idx on public.invoice_items(product_id);

create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path=public as $$
begin new.updated_at = now(); return new; end;
$$;
drop trigger if exists categories_updated_at on public.categories;
create trigger categories_updated_at before update on public.categories for each row execute function public.touch_updated_at();
drop trigger if exists products_updated_at on public.products;
create trigger products_updated_at before update on public.products for each row execute function public.touch_updated_at();
drop trigger if exists settings_updated_at on public.business_settings;
create trigger settings_updated_at before update on public.business_settings for each row execute function public.touch_updated_at();

create or replace function public.create_invoice(
  p_person_name text,
  p_payment_method text,
  p_amount_received numeric,
  p_notes text,
  p_idempotency_key uuid,
  p_items jsonb
) returns text
language plpgsql security definer set search_path=public as $$
declare
  v_id uuid; v_order text; v_old text; v_total numeric(12,2);
  v_now timestamptz := now(); v_number integer; v_prefix text;
begin
  select order_number into v_old from public.invoices where idempotency_key=p_idempotency_key;
  if v_old is not null then return v_old; end if;
  if length(trim(coalesce(p_person_name,'')))=0 then raise exception 'Escribe el nombre de la persona.'; end if;
  if p_payment_method not in ('cash','transfer','card','other') then raise exception 'Método de pago no válido.'; end if;
  if p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'Agrega al menos un producto.'; end if;
  if exists (
    select 1 from jsonb_array_elements(p_items) x
    where coalesce((x->>'quantity')::int,0)<=0
       or coalesce((x->>'unit_price')::numeric,-1)<0
       or length(trim(coalesce(x->>'product_name','')))=0
  ) then raise exception 'Revisa las cantidades y precios.'; end if;
  select round(sum((x->>'quantity')::int*(x->>'unit_price')::numeric),2)
     into v_total from jsonb_array_elements(p_items) x;
  if p_payment_method='cash' and coalesce(p_amount_received,0)<v_total then
    raise exception 'El dinero recibido es menor que el total.';
  end if;

  perform pg_advisory_xact_lock(hashtext(to_char(timezone('America/Guayaquil',v_now),'YYYYMMDD')));
  select count(*)+1 into v_number from public.invoices
    where (sold_at at time zone 'America/Guayaquil')::date=(v_now at time zone 'America/Guayaquil')::date;
  select order_prefix into v_prefix from public.business_settings where id=true;
  v_order := coalesce(v_prefix,'LFH')||'-'||to_char(timezone('America/Guayaquil',v_now),'YYYYMMDD')||'-'||lpad(v_number::text,3,'0');

  insert into public.invoices(order_number,sold_at,person_name,payment_method,total,amount_received,change_amount,notes,idempotency_key)
  values(v_order,v_now,trim(p_person_name),p_payment_method,v_total,
    case when p_payment_method='cash' then p_amount_received else v_total end,
    case when p_payment_method='cash' then greatest(p_amount_received-v_total,0) else 0 end,
    nullif(trim(coalesce(p_notes,'')),''),p_idempotency_key)
  returning id into v_id;

  insert into public.invoice_items(invoice_id,product_id,product_name,quantity,unit_price)
  select v_id,nullif(x->>'product_id','')::uuid,trim(x->>'product_name'),
    (x->>'quantity')::int,(x->>'unit_price')::numeric(12,2)
  from jsonb_array_elements(p_items) x;
  return v_order;
end;
$$;

create or replace function public.void_invoice(p_invoice_id uuid,p_reason text)
returns void language plpgsql security definer set search_path=public as $$
begin
  if length(trim(coalesce(p_reason,'')))=0 then raise exception 'El motivo de anulación es obligatorio.'; end if;
  if length(p_reason)>300 then raise exception 'El motivo no puede superar 300 caracteres.'; end if;
  if not exists(select 1 from public.invoices where id=p_invoice_id) then raise exception 'No se encontró la factura.'; end if;
  if exists(select 1 from public.invoices where id=p_invoice_id and status='voided') then raise exception 'La factura ya está anulada.'; end if;
  insert into public.invoice_voids(invoice_id,reason) values(p_invoice_id,trim(p_reason));
  update public.invoices set status='voided' where id=p_invoice_id;
end;
$$;

alter table public.categories enable row level security;
alter table public.payment_methods enable row level security;
alter table public.products enable row level security;
alter table public.invoices enable row level security;
alter table public.invoice_items enable row level security;
alter table public.invoice_voids enable row level security;
alter table public.business_settings enable row level security;
drop policy if exists "read_categories" on public.categories;
create policy "read_categories" on public.categories for select to anon using(true);
drop policy if exists "read_methods" on public.payment_methods;
create policy "read_methods" on public.payment_methods for select to anon using(true);
drop policy if exists "read_products" on public.products;
create policy "read_products" on public.products for select to anon using(true);
drop policy if exists "insert_products" on public.products;
create policy "insert_products" on public.products for insert to anon with check(true);
drop policy if exists "update_products" on public.products;
create policy "update_products" on public.products for update to anon using(true) with check(true);
drop policy if exists "read_invoices" on public.invoices;
create policy "read_invoices" on public.invoices for select to anon using(true);
drop policy if exists "read_items" on public.invoice_items;
create policy "read_items" on public.invoice_items for select to anon using(true);
drop policy if exists "read_voids" on public.invoice_voids;
create policy "read_voids" on public.invoice_voids for select to anon using(true);
drop policy if exists "read_settings" on public.business_settings;
create policy "read_settings" on public.business_settings for select to anon using(true);
grant usage on schema public to anon;
grant select on public.categories,public.payment_methods,public.invoices,public.invoice_items,public.invoice_voids,public.business_settings to anon;
grant select,insert,update on public.products to anon;
grant execute on function public.create_invoice(text,text,numeric,text,uuid,jsonb) to anon;
grant execute on function public.void_invoice(uuid,text) to anon;

insert into public.payment_methods(code,name,sort_order) values
('cash','Efectivo',1),('transfer','Transferencia',2),('card','Tarjeta',3),('other','Otro',4)
on conflict(code) do update set name=excluded.name,sort_order=excluded.sort_order;
insert into public.business_settings(id,business_name,currency_code,timezone,order_prefix)
values(true,'London Frozen and Hot','USD','America/Guayaquil','LFH')
on conflict(id) do update set business_name=excluded.business_name;
insert into public.categories(id,name) values
('10000000-0000-4000-8000-000000000001','Comida'),
('10000000-0000-4000-8000-000000000002','Bebidas'),
('10000000-0000-4000-8000-000000000003','Combos')
on conflict(id) do update set name=excluded.name;
insert into public.products(id,name,price,category_id,active) values
('20000000-0000-4000-8000-000000000001','Hamburguesa',2.50,'10000000-0000-4000-8000-000000000001',true),
('20000000-0000-4000-8000-000000000002','Salchipapa',3.00,'10000000-0000-4000-8000-000000000001',true),
('20000000-0000-4000-8000-000000000003','Papas fritas',2.00,'10000000-0000-4000-8000-000000000001',true),
('20000000-0000-4000-8000-000000000004','Gaseosa',1.00,'10000000-0000-4000-8000-000000000002',true),
('20000000-0000-4000-8000-000000000005','Agua',0.75,'10000000-0000-4000-8000-000000000002',true),
('20000000-0000-4000-8000-000000000006','Combo',5.00,'10000000-0000-4000-8000-000000000003',true),
('20000000-0000-4000-8000-000000000007','Porción adicional',1.50,'10000000-0000-4000-8000-000000000001',true)
on conflict(id) do update set name=excluded.name,price=excluded.price,category_id=excluded.category_id;

select public.create_invoice('Andrea','cash',10,'Factura de demostración',
'30000000-0000-4000-8000-000000000001',
'[{"product_id":"20000000-0000-4000-8000-000000000001","product_name":"Hamburguesa","quantity":2,"unit_price":3.50},{"product_id":"20000000-0000-4000-8000-000000000004","product_name":"Gaseosa","quantity":1,"unit_price":1.00}]'::jsonb);
select public.create_invoice('Camila','transfer',8,null,
'30000000-0000-4000-8000-000000000002',
'[{"product_id":"20000000-0000-4000-8000-000000000006","product_name":"Combo","quantity":1,"unit_price":5.00},{"product_id":"20000000-0000-4000-8000-000000000002","product_name":"Salchipapa","quantity":1,"unit_price":3.00}]'::jsonb);
