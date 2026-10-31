-- =====================================================================
-- Kiler Takip - Supabase veritabanı şeması
-- Supabase panelinde: SQL Editor > New query > bu dosyanın tamamını yapıştır > Run
-- =====================================================================

-- ---------- Tablolar ----------
create table if not exists public.locations (
  id         bigint generated always as identity primary key,
  name       text not null unique,
  sort       int  not null default 0
);

create table if not exists public.categories (
  id         bigint generated always as identity primary key,
  name       text not null unique,
  emoji      text not null default '📦'
);

create table if not exists public.items (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  category_id   bigint references public.categories(id) on delete set null,
  location_id   bigint references public.locations(id)  on delete set null,
  quantity      numeric not null default 0 check (quantity >= 0),
  unit          text not null default 'adet',
  min_quantity  numeric not null default 0 check (min_quantity >= 0),  -- 0 = uyarı yok
  expiry_date   date,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Her stok değişikliği burada kayıt altına alınır (grafikler + Power BI için)
create table if not exists public.movements (
  id             bigint generated always as identity primary key,
  item_id        uuid references public.items(id) on delete set null,
  item_name      text not null,
  category_name  text,
  location_name  text,
  unit           text,
  delta          numeric not null,        -- + eklenen, - tüketilen
  quantity_after numeric not null,
  created_at     timestamptz not null default now()
);

-- Elle eklenen alışveriş listesi satırları (azalan ürünler otomatik gelir)
create table if not exists public.shopping_extra (
  id          bigint generated always as identity primary key,
  name        text not null,
  created_at  timestamptz not null default now()
);

create index if not exists movements_created_idx on public.movements (created_at desc);
create index if not exists items_name_idx on public.items (name);

-- ---------- Tetikleyiciler ----------
create or replace function public.items_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_items_touch on public.items;
create trigger trg_items_touch before update on public.items
  for each row execute function public.items_touch();

create or replace function public.items_log_movement()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  d numeric;
  cat text;
  loc text;
begin
  if tg_op = 'INSERT' then
    d := new.quantity;
  else
    d := new.quantity - old.quantity;
  end if;

  if d = 0 then
    return new;
  end if;

  select name into cat from public.categories where id = new.category_id;
  select name into loc from public.locations  where id = new.location_id;

  insert into public.movements (item_id, item_name, category_name, location_name, unit, delta, quantity_after)
  values (new.id, new.name, cat, loc, new.unit, d, new.quantity);
  return new;
end $$;

drop trigger if exists trg_items_log on public.items;
create trigger trg_items_log after insert or update of quantity on public.items
  for each row execute function public.items_log_movement();

-- Hızlı +/- için atomik fonksiyon (iki telefon aynı anda basarsa da doğru çalışır)
create or replace function public.adjust_item(p_id uuid, p_delta numeric)
returns numeric language plpgsql as $$
declare q numeric;
begin
  update public.items
     set quantity = greatest(0, quantity + p_delta)
   where id = p_id
  returning quantity into q;
  return q;
end $$;

-- ---------- Güvenlik (RLS): sadece giriş yapmış kullanıcı erişebilir ----------
alter table public.locations      enable row level security;
alter table public.categories     enable row level security;
alter table public.items          enable row level security;
alter table public.movements      enable row level security;
alter table public.shopping_extra enable row level security;

do $$
declare t text;
begin
  foreach t in array array['locations','categories','items','movements','shopping_extra'] loop
    execute format('drop policy if exists "auth_all" on public.%I', t);
    execute format('create policy "auth_all" on public.%I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;

-- ---------- Canlı senkronizasyon (iki telefon birbirini anında görsün) ----------
do $$
begin
  begin alter publication supabase_realtime add table public.items;          exception when others then null; end;
  begin alter publication supabase_realtime add table public.shopping_extra; exception when others then null; end;
  begin alter publication supabase_realtime add table public.categories;     exception when others then null; end;
  begin alter publication supabase_realtime add table public.locations;      exception when others then null; end;
end $$;

-- ---------- Power BI / Alteryx için hazır görünümler ----------
create or replace view public.v_stok with (security_invoker = true) as
select i.id, i.name as urun, c.name as kategori, l.name as konum,
       i.quantity as miktar, i.unit as birim, i.min_quantity as minimum,
       (i.min_quantity > 0 and i.quantity <= i.min_quantity) as azaldi_mi,
       i.expiry_date as son_kullanma, (i.expiry_date - current_date) as kalan_gun,
       i.created_at, i.updated_at
from public.items i
left join public.categories c on c.id = i.category_id
left join public.locations  l on l.id = i.location_id;

create or replace view public.v_hareketler with (security_invoker = true) as
select m.id, m.created_at as zaman,
       (m.created_at at time zone 'Europe/Istanbul')::date as tarih,
       m.item_name as urun, m.category_name as kategori, m.location_name as konum,
       m.unit as birim, m.delta as degisim,
       case when m.delta < 0 then 'Tüketim' else 'Ekleme' end as tur,
       abs(m.delta) as miktar, m.quantity_after as kalan
from public.movements m;

-- ---------- Varsayılan konum ve kategoriler ----------
insert into public.locations (name, sort) values
  ('Buzdolabı', 1), ('Dondurucu', 2), ('Kiler', 3), ('Dolap', 4)
on conflict (name) do nothing;

insert into public.categories (name, emoji) values
  ('Sebze & Meyve', '🥦'),
  ('Süt & Kahvaltılık', '🥛'),
  ('Et & Tavuk & Balık', '🍗'),
  ('Bakliyat & Makarna', '🍝'),
  ('Konserve & Sos', '🥫'),
  ('İçecek', '🥤'),
  ('Atıştırmalık', '🍪'),
  ('Temizlik & Bakım', '🧽'),
  ('Diğer', '📦')
on conflict (name) do nothing;

-- =====================================================================
-- İSTEĞE BAĞLI: Power BI / Alteryx için salt-okunur kullanıcı
-- (Dilersen aşağıdaki satırların başındaki -- işaretlerini kaldır, şifreyi değiştir, çalıştır.)
-- =====================================================================
-- create role powerbi_reader login password 'BURAYA-GUCLU-BIR-SIFRE';
-- grant usage on schema public to powerbi_reader;
-- grant select on public.items, public.movements, public.categories, public.locations,
--                 public.shopping_extra, public.v_stok, public.v_hareketler to powerbi_reader;
-- do $$ declare t text; begin
--   foreach t in array array['items','movements','categories','locations','shopping_extra'] loop
--     execute format('create policy "reader_select" on public.%I for select to powerbi_reader using (true)', t);
--   end loop; end $$;
