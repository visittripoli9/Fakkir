-- =====================================================================
-- FAKKIR — visitor analytics for the admin panel ("who opened the site").
--
-- Run in the Supabase SQL Editor. Creates a `visits` table the client writes
-- to on every load. Privacy by design:
--   * anyone (anon) may INSERT a visit (so logging needs no login)
--   * NOBODY may SELECT via the public anon/authenticated keys
--     (there is no select policy) — only the owner reading with the
--     service_role key (which bypasses RLS) can see visitor data.
--   * the real client IP is captured server-side from the request headers,
--     so it can't be forged by the browser.
-- =====================================================================

create table if not exists visits (
  id          bigserial primary key,
  session_id  text,
  user_id     uuid,
  user_name   text,
  path        text,
  referrer    text,
  user_agent  text,
  language    text,
  screen      text,
  tz          text,
  ip          text,
  created_at  timestamptz not null default now()
);

create index if not exists idx_visits_created_at on visits(created_at desc);
create index if not exists idx_visits_session    on visits(session_id);
create index if not exists idx_visits_user        on visits(user_id);

alter table visits enable row level security;

-- public may log a visit (size-bounded); NO select policy => visitor data is
-- private to the owner's service_role key.
drop policy if exists "public insert visits" on visits;
create policy "public insert visits" on visits for insert to anon, authenticated
  with check (
    char_length(coalesce(session_id, '')) <= 64
    and char_length(coalesce(user_name, '')) <= 40
    and char_length(coalesce(path, '')) <= 200
    and char_length(coalesce(referrer, '')) <= 300
    and char_length(coalesce(user_agent, '')) <= 400
    and char_length(coalesce(language, '')) <= 40
    and char_length(coalesce(screen, '')) <= 20
    and char_length(coalesce(tz, '')) <= 60
  );

-- BEFORE INSERT: capture the real IP from request headers (can't be spoofed by
-- the client), clamp text, and throttle floods (≤30 rows / session / minute).
create or replace function fakkir_visit_meta() returns trigger as $$
declare hdrs json;
begin
  begin hdrs := current_setting('request.headers', true)::json; exception when others then hdrs := null; end;
  if hdrs is not null then
    new.ip := coalesce(
      hdrs->>'cf-connecting-ip',
      nullif(split_part(coalesce(hdrs->>'x-forwarded-for',''), ',', 1), ''),
      new.ip
    );
  end if;
  new.user_agent := left(coalesce(new.user_agent, ''), 400);
  new.referrer   := left(coalesce(new.referrer, ''), 300);
  new.path       := left(coalesce(new.path, ''), 200);
  new.user_name  := left(btrim(coalesce(new.user_name, '')), 40);
  if (select count(*) from visits v
        where v.session_id = new.session_id
          and v.created_at > now() - interval '1 minute') >= 30 then
    raise exception 'too many visit events';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_visit_meta on visits;
create trigger trg_visit_meta before insert on visits
  for each row execute function fakkir_visit_meta();

grant insert on visits to anon, authenticated;
grant usage, select on sequence visits_id_seq to anon, authenticated;
