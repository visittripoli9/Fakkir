-- =====================================================================
-- FAKKIR — email-based admin access (TEMPLATE).
--
-- Copy this to `admin-users.sql` (which is gitignored so your real admin
-- email is never committed), replace the placeholder email, and run it in
-- the Supabase SQL Editor after schema.sql.
--
-- An admin, once signed in with email+password, can manage all content and
-- read the private visitor analytics — enforced entirely by RLS (tied to
-- their JWT email). No service_role secret key needed.
--
-- Prerequisite: the admin email must have a Supabase Auth account.
-- =====================================================================

create table if not exists public.admin_users (
  email      text primary key,
  created_at timestamptz not null default now(),
  check (email = lower(btrim(email)) and position('@' in email) > 1)
);

alter table public.admin_users enable row level security;

-- 🔴 REPLACE with your real admin email before running:
insert into public.admin_users(email)
values ('your-admin@example.com')
on conflict (email) do nothing;

create or replace function public.fakkir_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.admin_users a
    where a.email = lower(coalesce(auth.jwt()->>'email', ''))
  );
$$;

revoke all on function public.fakkir_is_admin() from public;
grant execute on function public.fakkir_is_admin() to anon, authenticated;

drop policy if exists "admin read admin users" on public.admin_users;
create policy "admin read admin users" on public.admin_users
  for select to authenticated
  using (public.fakkir_is_admin());

grant select on public.admin_users to authenticated;

-- Core game tables.
drop policy if exists "admin manage categories" on public.categories;
create policy "admin manage categories" on public.categories
  for all to authenticated using (public.fakkir_is_admin()) with check (public.fakkir_is_admin());

drop policy if exists "admin manage flags" on public.flags;
create policy "admin manage flags" on public.flags
  for all to authenticated using (public.fakkir_is_admin()) with check (public.fakkir_is_admin());

drop policy if exists "admin manage questions" on public.questions;
create policy "admin manage questions" on public.questions
  for all to authenticated using (public.fakkir_is_admin()) with check (public.fakkir_is_admin());

drop policy if exists "admin manage matches" on public.matches;
create policy "admin manage matches" on public.matches
  for all to authenticated using (public.fakkir_is_admin()) with check (public.fakkir_is_admin());

grant select, insert, update, delete on public.categories to authenticated;
grant select, insert, update, delete on public.flags to authenticated;
grant select, insert, update, delete on public.questions to authenticated;
grant select, insert, update, delete on public.matches to authenticated;
grant usage, select on sequence public.questions_id_seq to authenticated;
grant usage, select on sequence public.matches_id_seq to authenticated;

-- Optional analytics table (admin-analytics.sql).
do $$
begin
  if to_regclass('public.visits') is not null then
    execute 'drop policy if exists "admin read visits" on public.visits';
    execute 'create policy "admin read visits" on public.visits for select to authenticated using (public.fakkir_is_admin())';
    execute 'grant select on public.visits to authenticated';
  end if;
end $$;

-- Optional Blitz table (blitz.sql).
do $$
begin
  if to_regclass('public.blitz_scores') is not null then
    execute 'drop policy if exists "admin manage blitz scores" on public.blitz_scores';
    execute 'create policy "admin manage blitz scores" on public.blitz_scores for all to authenticated using (public.fakkir_is_admin()) with check (public.fakkir_is_admin())';
    execute 'grant select, insert, update, delete on public.blitz_scores to authenticated';
  end if;
  if to_regclass('public.blitz_scores_id_seq') is not null then
    execute 'grant usage, select on sequence public.blitz_scores_id_seq to authenticated';
  end if;
end $$;
