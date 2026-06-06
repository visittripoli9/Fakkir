create table if not exists categories (
  slug text primary key,
  name text not null,
  color text not null default 'blue',
  image text not null,
  sort_order int not null default 0
);

create table if not exists flags (
  key text primary key,
  image text not null
);

create table if not exists questions (
  id bigserial primary key,
  category text not null references categories(slug) on delete cascade,
  version int not null default 1,
  ord int not null,
  value int not null,
  type text not null default 'normal',
  q text,
  a text not null,
  note text,
  flag text references flags(key),
  clues jsonb,
  num numeric,
  evidence text,
  suspects jsonb,
  image text,
  unique(category, version, ord)
);

-- migration for databases created before the per-question image column existed
alter table questions add column if not exists image text;

create table if not exists matches (
  id bigserial primary key,
  blue_name text not null,
  red_name text not null,
  blue_score int not null,
  red_score int not null,
  winner text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_questions_category_version on questions(category, version);
create index if not exists idx_matches_created_at on matches(created_at desc);

alter table categories enable row level security;
alter table flags enable row level security;
alter table questions enable row level security;
alter table matches enable row level security;

drop policy if exists "public read categories" on categories;
create policy "public read categories" on categories for select using (true);

drop policy if exists "public read flags" on flags;
create policy "public read flags" on flags for select using (true);

drop policy if exists "public read questions" on questions;
create policy "public read questions" on questions for select using (true);

drop policy if exists "public read matches" on matches;
create policy "public read matches" on matches for select using (true);

-- =====================================================================
-- Security hardening for match results (leaderboard anti-abuse).
--
-- Threat model: the browser uses the public anon key, so anyone can call
-- the matches INSERT endpoint. categories/questions/flags are read-only by
-- default (RLS is enabled and there is NO insert/update/delete policy, so
-- those writes are denied for the anon key — only the service_role key,
-- which bypasses RLS, can seed/edit them). Matches are the only public
-- write, so we constrain them tightly here.
--
-- Note: this game deducts points on wrong answers, so a final score can be
-- legitimately negative. We therefore bound scores in BOTH directions
-- instead of forbidding negatives.
-- =====================================================================

-- Column-level CHECK constraints (always enforced, even for service_role).
alter table matches drop constraint if exists matches_score_bounds;
alter table matches add  constraint matches_score_bounds
  check (blue_score between -100000 and 100000 and red_score between -100000 and 100000);

alter table matches drop constraint if exists matches_name_bounds;
alter table matches add  constraint matches_name_bounds
  check (char_length(blue_name) between 1 and 40
     and char_length(red_name)  between 1 and 40
     and char_length(winner)    between 1 and 40);

-- BEFORE-INSERT trigger: trim/clamp names, validate the winner, and block
-- duplicate spam submissions (same result inserted within a few seconds).
create or replace function fakkir_validate_match() returns trigger as $$
begin
  -- normalise + clamp text so manipulated/oversized names can't get through
  new.blue_name := left(btrim(coalesce(new.blue_name, '')), 40);
  new.red_name  := left(btrim(coalesce(new.red_name,  '')), 40);
  new.winner    := left(btrim(coalesce(new.winner,    '')), 40);
  if new.blue_name = '' then new.blue_name := 'الفريق الأزرق'; end if;
  if new.red_name  = '' then new.red_name  := 'الفريق الأحمر'; end if;

  -- the winner must be one of the two teams, or an explicit tie
  if new.winner not in (new.blue_name, new.red_name, 'تعادل') then
    raise exception 'invalid winner: must be a team name or a tie';
  end if;

  -- duplicate / spam guard: reject an identical result seen in the last 5s
  if exists (
    select 1 from matches m
    where m.blue_name  = new.blue_name
      and m.red_name   = new.red_name
      and m.blue_score = new.blue_score
      and m.red_score  = new.red_score
      and m.created_at > now() - interval '5 seconds'
  ) then
    raise exception 'duplicate match submission';
  end if;

  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_validate_match on matches;
create trigger trg_validate_match before insert on matches
  for each row execute function fakkir_validate_match();

-- Insert policy (defence in depth alongside the constraints above).
drop policy if exists "public insert matches" on matches;
create policy "public insert matches" on matches for insert with check (
  blue_score between -100000 and 100000
  and red_score between -100000 and 100000
  and char_length(blue_name) between 1 and 40
  and char_length(red_name)  between 1 and 40
  and char_length(winner)    between 1 and 40
);

-- Supports the duplicate-submission lookup in the trigger above.
create index if not exists idx_matches_dedup on matches(blue_name, red_name, created_at desc);
