-- =====================================================================
-- FAKKIR — Blitz (تحدٍّ سريع) leaderboard with authenticated submissions.
--
-- Run this in the Supabase SQL Editor AFTER schema.sql. It adds:
--   * blitz_scores            one row per finished solo Blitz run
--   * blitz_leaderboard view  best score per player, for ranking
--
-- Login: players sign in with email + password (Supabase Auth). Only an
-- authenticated user may insert, and only their OWN row (auth.uid() = user_id).
-- Reads are public so the leaderboard is visible to everyone.
--
-- IMPORTANT: enable Email auth in your project (Authentication → Providers →
-- Email). To let players play immediately after sign-up, turn OFF
-- "Confirm email" (Authentication → Providers → Email → Confirm email),
-- otherwise they must click the confirmation link before their first game.
-- =====================================================================

create table if not exists blitz_scores (
  id          bigserial primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  player_name text not null,
  score       int  not null,
  correct     int  not null default 0,
  answered    int  not null default 0,
  max_streak  int  not null default 0,
  version     int  not null default 1,
  created_at  timestamptz not null default now()
);

create index if not exists idx_blitz_scores_score on blitz_scores(score desc);
create index if not exists idx_blitz_scores_user  on blitz_scores(user_id);

-- hard bounds (enforced even for the service_role key)
alter table blitz_scores drop constraint if exists blitz_scores_bounds;
alter table blitz_scores add  constraint blitz_scores_bounds
  check (score between 0 and 1000000
     and correct between 0 and 100000
     and answered between 0 and 100000
     and max_streak between 0 and 100000
     and char_length(player_name) between 1 and 40);

alter table blitz_scores enable row level security;

-- anyone can read the leaderboard
drop policy if exists "public read blitz" on blitz_scores;
create policy "public read blitz" on blitz_scores for select using (true);

-- only a logged-in user can submit, and only their own score
drop policy if exists "auth insert own blitz" on blitz_scores;
create policy "auth insert own blitz" on blitz_scores for insert to authenticated
  with check (
    auth.uid() = user_id
    and score between 0 and 1000000
    and char_length(player_name) between 1 and 40
  );

-- BEFORE-INSERT trigger: normalise the name and throttle rapid repeat submissions
-- (defence in depth alongside the RLS policy and CHECK constraints above).
create or replace function fakkir_validate_blitz() returns trigger as $$
begin
  new.player_name := left(btrim(coalesce(new.player_name, '')), 40);
  if new.player_name = '' then new.player_name := 'لاعب'; end if;
  -- flood guard: at most 5 submissions per user per 10 seconds
  if (select count(*) from blitz_scores b
        where b.user_id = new.user_id
          and b.created_at > now() - interval '10 seconds') >= 5 then
    raise exception 'too many submissions, slow down';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_validate_blitz on blitz_scores;
create trigger trg_validate_blitz before insert on blitz_scores
  for each row execute function fakkir_validate_blitz();

-- ranked board: the single best run per player (highest score, earliest on ties)
create or replace view blitz_leaderboard
  with (security_invoker = true) as
select distinct on (user_id)
  user_id, player_name, score, correct, answered, max_streak, created_at
from blitz_scores
order by user_id, score desc, created_at asc;

-- PostgREST/role privileges (RLS still restricts which rows are visible/insertable)
grant select, insert on blitz_scores to authenticated;
grant select on blitz_scores to anon;
grant select on blitz_leaderboard to anon, authenticated;
grant usage, select on sequence blitz_scores_id_seq to authenticated;
