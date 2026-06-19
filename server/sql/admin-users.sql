-- =====================================================================
-- FAKKIR — email-based admin access.
--
-- Run this in the Supabase SQL Editor after schema.sql. It replaces the old
-- browser-side service_role-key workflow with Supabase Auth + RLS:
--   1) create/sign in with the Auth user abedhajjo57@gmail.com
--   2) this SQL allowlists that email as an admin
--   3) the admin page uses the user's JWT, and these policies decide access
--
-- Safe to re-run.
-- =====================================================================

create table if not exists public.admin_users (
  email      text primary key,
  created_at timestamptz not null default now(),
  check (email = lower(btrim(email)) and position('@' in email) > 1)
);

alter table public.admin_users enable row level security;

insert into public.admin_users(email)
values ('abedhajjo57@gmail.com')
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
  for all to authenticated
  using (public.fakkir_is_admin())
  with check (public.fakkir_is_admin());

drop policy if exists "admin manage flags" on public.flags;
create policy "admin manage flags" on public.flags
  for all to authenticated
  using (public.fakkir_is_admin())
  with check (public.fakkir_is_admin());

drop policy if exists "admin manage questions" on public.questions;
create policy "admin manage questions" on public.questions
  for all to authenticated
  using (public.fakkir_is_admin())
  with check (public.fakkir_is_admin());

drop policy if exists "admin manage matches" on public.matches;
create policy "admin manage matches" on public.matches
  for all to authenticated
  using (public.fakkir_is_admin())
  with check (public.fakkir_is_admin());

grant select, insert, update, delete on public.categories to authenticated;
grant select, insert, update, delete on public.flags to authenticated;
grant select, insert, update, delete on public.questions to authenticated;
grant select, insert, update, delete on public.matches to authenticated;
grant usage, select on sequence public.questions_id_seq to authenticated;
grant usage, select on sequence public.matches_id_seq to authenticated;

-- Optional admin analytics table from admin-analytics.sql.
do $$
begin
  if to_regclass('public.visits') is not null then
    execute 'drop policy if exists "admin read visits" on public.visits';
    execute 'create policy "admin read visits" on public.visits for select to authenticated using (public.fakkir_is_admin())';
    execute 'grant select on public.visits to authenticated';
  end if;
end $$;

-- Optional Blitz leaderboard table from blitz.sql.
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
