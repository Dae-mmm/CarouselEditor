-- Libreria PNG (divisori, cornici, sticker…) + ruolo admin
--
-- Per nominare il primo admin, esegui una volta nel SQL Editor:
--   update public.profiles set is_admin = true where email = 'tua@email.com';

-- ---------------------------------------------------------------------------
-- Admin flag (non modificabile da un utente normale)
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists is_admin boolean not null default false;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select p.is_admin from public.profiles p where p.id = auth.uid()),
    false
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

create or replace function public.protect_is_admin()
returns trigger
language plpgsql
as $$
begin
  if new.is_admin is distinct from old.is_admin
     and auth.uid() is not null
     and not public.is_admin() then
    raise exception 'Solo un admin può cambiare il ruolo admin';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_protect_is_admin on public.profiles;
create trigger profiles_protect_is_admin
  before update on public.profiles
  for each row
  execute function public.protect_is_admin();

-- ---------------------------------------------------------------------------
-- Catalogo asset
-- ---------------------------------------------------------------------------
create table if not exists public.library_assets (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null default 'altro'
    check (category in ('divisori', 'cornici', 'sticker', 'forme', 'altro')),
  storage_path text not null unique,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists library_assets_category_idx on public.library_assets (category, created_at desc);

comment on table public.library_assets is 'PNG/WebP della libreria grafica (divisori, cornici, ecc.)';

grant select on table public.library_assets to anon, authenticated;
grant insert, update, delete on table public.library_assets to authenticated;

alter table public.library_assets enable row level security;

drop policy if exists "Anyone can view library assets" on public.library_assets;
create policy "Anyone can view library assets"
  on public.library_assets
  for select
  to anon, authenticated
  using (true);

drop policy if exists "Admins insert library assets" on public.library_assets;
create policy "Admins insert library assets"
  on public.library_assets
  for insert
  to authenticated
  with check (public.is_admin());

drop policy if exists "Admins update library assets" on public.library_assets;
create policy "Admins update library assets"
  on public.library_assets
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "Admins delete library assets" on public.library_assets;
create policy "Admins delete library assets"
  on public.library_assets
  for delete
  to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- Storage bucket pubblico (lettura) / scrittura solo admin
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'library',
  'library',
  true,
  6291456,
  array['image/png', 'image/webp']::text[]
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Public read library objects" on storage.objects;
create policy "Public read library objects"
  on storage.objects
  for select
  to public
  using (bucket_id = 'library');

drop policy if exists "Admins insert library objects" on storage.objects;
create policy "Admins insert library objects"
  on storage.objects
  for insert
  to authenticated
  with check (bucket_id = 'library' and public.is_admin());

drop policy if exists "Admins update library objects" on storage.objects;
create policy "Admins update library objects"
  on storage.objects
  for update
  to authenticated
  using (bucket_id = 'library' and public.is_admin())
  with check (bucket_id = 'library' and public.is_admin());

drop policy if exists "Admins delete library objects" on storage.objects;
create policy "Admins delete library objects"
  on storage.objects
  for delete
  to authenticated
  using (bucket_id = 'library' and public.is_admin());
