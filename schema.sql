create table if not exists public.houses (
  id text primary key,
  name text not null default 'Casa',
  created_at timestamptz not null default now()
);

create table if not exists public.shopping_items (
  id uuid primary key default gen_random_uuid(),
  house_id text not null references public.houses(id) on delete cascade,
  product_id text not null,
  texto text not null,
  formato text not null default '',
  categoria text not null default '',
  subcategoria text not null default '',
  ruta text not null default '',
  pagina integer,
  cantidad integer not null default 1 check (cantidad between 1 and 99),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (house_id, product_id)
);

create table if not exists public.purchases (
  id uuid primary key default gen_random_uuid(),
  house_id text not null references public.houses(id) on delete cascade,
  items jsonb not null,
  purchased_at timestamptz not null default now()
);

create table if not exists public.catalog_products (
  id text primary key,
  codigo text not null,
  texto text not null,
  formato text not null default '',
  packaging text not null default '',
  categoria text not null default '',
  subcategoria text not null default '',
  ruta text not null default '',
  pagina integer,
  imagen text not null default '',
  updated_at timestamptz not null default now()
);

create index if not exists shopping_items_house_id_idx on public.shopping_items(house_id);
create index if not exists purchases_house_id_idx on public.purchases(house_id, purchased_at desc);
create index if not exists catalog_products_categoria_idx on public.catalog_products(categoria);

alter table public.houses enable row level security;
alter table public.shopping_items enable row level security;
alter table public.purchases enable row level security;
alter table public.catalog_products enable row level security;
