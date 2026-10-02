-- RiftTiers Supabase schema
-- Run this whole file once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- Safe to re-run: everything uses IF NOT EXISTS / CREATE OR REPLACE / ON CONFLICT.

-- ============================================================
-- 1. CORE TABLES
-- ============================================================

create table if not exists players (
  id bigint generated always as identity primary key,
  username text not null,
  username_lower text generated always as (lower(username)) stored,
  discord_id text unique,
  platform text default 'premium',
  region text,
  created_at timestamptz not null default now()
);
create unique index if not exists players_username_lower_key on players (username_lower);

create table if not exists player_tiers (
  player_id bigint not null references players(id) on delete cascade,
  gamemode text not null,
  tier text not null,
  updated_at timestamptz not null default now(),
  primary key (player_id, gamemode)
);

create table if not exists cooldowns (
  player_id bigint not null references players(id) on delete cascade,
  gamemode text not null,
  until timestamptz not null,
  primary key (player_id, gamemode)
);

create table if not exists queue_entries (
  id bigint generated always as identity primary key,
  gamemode text not null,
  region text not null,
  player_id bigint not null references players(id) on delete cascade,
  joined_at timestamptz not null default now(),
  unique (gamemode, player_id)
);

create table if not exists queue_testers (
  gamemode text not null,
  player_id bigint not null references players(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (gamemode, player_id)
);

create table if not exists queue_closed (
  gamemode text primary key,
  closed boolean not null default false,
  region text,
  last_opened_at timestamptz
);

-- Safe to re-run against a queue_closed table created before this column existed.
alter table queue_closed add column if not exists last_opened_at timestamptz;

create table if not exists live_tests (
  id bigint generated always as identity primary key,
  player_id bigint not null references players(id) on delete cascade,
  gamemode text not null,
  region text,
  tester_id bigint references players(id) on delete cascade,
  tester_names text[],                 -- display names of everyone co-testing (Discord-side, for the website)
  discord_ticket_channel_id text,      -- set when this test is happening in a Discord ticket
  started_at timestamptz not null default now()
);

-- Safe to re-run against a live_tests table created before these existed.
alter table live_tests alter column tester_id drop not null;
alter table live_tests add column if not exists tester_names text[];
alter table live_tests add column if not exists discord_ticket_channel_id text;

create table if not exists test_log (
  id bigint generated always as identity primary key,
  player_id bigint references players(id) on delete set null,
  gamemode text not null,
  tier text not null,
  previous_tier text,
  tester_id bigint references players(id) on delete set null,
  tester_names text[],  -- display names of everyone who tested (co-testing), for the website
  region text,
  created_at timestamptz not null default now()
);

alter table test_log add column if not exists tester_names text[];
-- Lets /backfilllogs re-run safely without creating duplicate entries.
alter table test_log add column if not exists discord_message_id text;
create unique index if not exists test_log_discord_message_id_key
  on test_log (discord_message_id) where discord_message_id is not null;

-- One row per logged-in Discord account. Links auth.users -> players,
-- and caches the Tester/Manager role check so we don't hit Discord's API
-- on every single click.
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  discord_id text unique not null,
  discord_username text,
  player_id bigint references players(id),
  is_tester boolean not null default false,          -- tester, senior tester, manager or owner
  is_senior_tester boolean not null default false,    -- senior tester or owner
  is_manager boolean not null default false,          -- manager or owner
  is_moderator boolean not null default false,        -- moderator or owner — ticket/support access
  is_owner boolean not null default false,            -- owner only — can do anything
  roles_synced_at timestamptz
);

-- Safe to re-run against a profiles table created before these columns existed.
alter table profiles add column if not exists is_senior_tester boolean not null default false;
alter table profiles add column if not exists is_moderator boolean not null default false;
alter table profiles add column if not exists is_owner boolean not null default false;

-- ============================================================
-- 2. NEW LOGIN -> PROFILE + PLAYER ROW, AUTOMATICALLY
-- ============================================================

create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_discord_id text;
  v_username text;
  v_player_id bigint;
begin
  v_discord_id := new.raw_user_meta_data->>'provider_id';
  v_username := coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', 'Player' || substr(new.id::text, 1, 6));

  insert into players (username, discord_id)
  values (v_username, v_discord_id)
  on conflict (discord_id) do update set username = excluded.username
  returning id into v_player_id;

  insert into profiles (id, discord_id, discord_username, player_id)
  values (new.id, v_discord_id, v_username, v_player_id)
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ============================================================
-- 3. ROW LEVEL SECURITY — public can read, nobody can write directly
--    (all writes happen through the security-definer functions below)
-- ============================================================

alter table players enable row level security;
alter table player_tiers enable row level security;
alter table cooldowns enable row level security;
alter table queue_entries enable row level security;
alter table queue_testers enable row level security;
alter table queue_closed enable row level security;
alter table live_tests enable row level security;
alter table test_log enable row level security;
alter table profiles enable row level security;

drop policy if exists "public read" on players;
create policy "public read" on players for select using (true);

drop policy if exists "public read" on player_tiers;
create policy "public read" on player_tiers for select using (true);

drop policy if exists "public read" on queue_entries;
create policy "public read" on queue_entries for select using (true);

drop policy if exists "public read" on queue_testers;
create policy "public read" on queue_testers for select using (true);

drop policy if exists "public read" on queue_closed;
create policy "public read" on queue_closed for select using (true);

drop policy if exists "public read" on live_tests;
create policy "public read" on live_tests for select using (true);

drop policy if exists "public read" on test_log;
create policy "public read" on test_log for select using (true);

-- cooldowns are only meaningful to the person they apply to + testers; keep private
drop policy if exists "own row" on cooldowns;
create policy "own row" on cooldowns for select using (
  player_id = (select player_id from profiles where id = auth.uid())
);

drop policy if exists "own profile" on profiles;
create policy "own profile" on profiles for select using (id = auth.uid());

-- ============================================================
-- 4. HELPERS
-- ============================================================

create or replace function current_player_id()
returns bigint
language sql
security definer
stable
as $$
  select player_id from profiles where id = auth.uid();
$$;

create or replace function current_is_tester()
returns boolean
language sql
security definer
stable
as $$
  select coalesce(is_tester, false) from profiles where id = auth.uid();
$$;

create or replace function current_is_manager()
returns boolean
language sql
security definer
stable
as $$
  select coalesce(is_manager, false) from profiles where id = auth.uid();
$$;

create or replace function current_is_senior_tester()
returns boolean
language sql
security definer
stable
as $$
  select coalesce(is_senior_tester, false) from profiles where id = auth.uid();
$$;

-- Moderators (and owners) get ticket/support oversight — "can access all tickets".
create or replace function current_is_moderator()
returns boolean
language sql
security definer
stable
as $$
  select coalesce(is_moderator, false) from profiles where id = auth.uid();
$$;

create or replace function current_is_owner()
returns boolean
language sql
security definer
stable
as $$
  select coalesce(is_owner, false) from profiles where id = auth.uid();
$$;

-- ============================================================
-- 5. QUEUE ACTIONS (players)
-- ============================================================

create or replace function join_queue(p_gamemode text, p_region text)
returns void
language plpgsql
security definer
as $$
declare
  v_player_id bigint := current_player_id();
  v_closed boolean;
  v_cooldown_until timestamptz;
begin
  if v_player_id is null then
    raise exception 'not logged in';
  end if;

  select closed into v_closed from queue_closed where gamemode = p_gamemode;
  if v_closed and not current_is_tester() then
    raise exception 'queue is closed';
  end if;

  select until into v_cooldown_until from cooldowns
    where player_id = v_player_id and gamemode = p_gamemode;
  if v_cooldown_until is not null and v_cooldown_until > now() then
    raise exception 'on cooldown until %', v_cooldown_until;
  end if;

  insert into queue_entries (gamemode, region, player_id)
  values (p_gamemode, p_region, v_player_id)
  on conflict (gamemode, player_id) do nothing;
end;
$$;

create or replace function leave_queue(p_gamemode text)
returns void
language plpgsql
security definer
as $$
begin
  delete from queue_entries
    where gamemode = p_gamemode and player_id = current_player_id();
end;
$$;

-- ============================================================
-- 6. TESTER ACTIONS
-- ============================================================

create or replace function join_testing(p_gamemode text)
returns void
language plpgsql
security definer
as $$
begin
  if not current_is_tester() then
    raise exception 'testers only';
  end if;
  insert into queue_testers (gamemode, player_id)
  values (p_gamemode, current_player_id())
  on conflict (gamemode, player_id) do nothing;
end;
$$;

create or replace function leave_testing(p_gamemode text)
returns void
language plpgsql
security definer
as $$
begin
  delete from queue_testers
    where gamemode = p_gamemode and player_id = current_player_id();
end;
$$;

create or replace function set_queue_closed(p_gamemode text, p_closed boolean, p_region text default null)
returns void
language plpgsql
security definer
as $$
begin
  if not current_is_tester() then
    raise exception 'testers only';
  end if;
  insert into queue_closed (gamemode, closed, region, last_opened_at)
  values (p_gamemode, p_closed, p_region, case when p_closed then null else now() end)
  on conflict (gamemode) do update set closed = excluded.closed,
    region = coalesce(excluded.region, queue_closed.region),
    last_opened_at = case when excluded.closed then queue_closed.last_opened_at else now() end;
end;
$$;

-- Claims the longest-waiting person in a gamemode's queue and starts a live test.
-- Returns the claimed player's info so the UI can show it immediately.
create or replace function claim_next(p_gamemode text)
returns table (live_test_id bigint, player_id bigint, username text, region text)
language plpgsql
security definer
as $$
declare
  v_tester_id bigint := current_player_id();
  v_entry record;
  v_live_test_id bigint;
begin
  if not current_is_tester() then
    raise exception 'testers only';
  end if;

  select * into v_entry from queue_entries
    where gamemode = p_gamemode
    order by joined_at asc
    limit 1
    for update skip locked;

  if v_entry is null then
    return;
  end if;

  delete from queue_entries where id = v_entry.id;

  insert into live_tests (player_id, gamemode, region, tester_id)
  values (v_entry.player_id, p_gamemode, v_entry.region, v_tester_id)
  returning id into v_live_test_id;

  return query
    select v_live_test_id, p.id, p.username, v_entry.region
    from players p where p.id = v_entry.player_id;
end;
$$;

create or replace function cancel_live_test(p_live_test_id bigint)
returns void
language plpgsql
security definer
as $$
begin
  if not current_is_tester() then
    raise exception 'testers only';
  end if;
  delete from live_tests where id = p_live_test_id;
end;
$$;

-- ============================================================
-- 7. RESULTS (the "Results" subtab)
-- ============================================================

create or replace function submit_result(p_live_test_id bigint, p_tier text)
returns void
language plpgsql
security definer
as $$
declare
  v_live record;
  v_previous_tier text;
begin
  if not current_is_tester() then
    raise exception 'testers only';
  end if;

  select * into v_live from live_tests where id = p_live_test_id;
  if v_live is null then
    raise exception 'that test is no longer live';
  end if;

  select tier into v_previous_tier from player_tiers
    where player_id = v_live.player_id and gamemode = v_live.gamemode;

  insert into player_tiers (player_id, gamemode, tier, updated_at)
  values (v_live.player_id, v_live.gamemode, p_tier, now())
  on conflict (player_id, gamemode) do update set tier = excluded.tier, updated_at = now();

  insert into test_log (player_id, gamemode, tier, previous_tier, tester_id, tester_names, region)
  values (
    v_live.player_id, v_live.gamemode, p_tier, v_previous_tier, v_live.tester_id,
    coalesce(v_live.tester_names, array[(select username from players where id = v_live.tester_id)]),
    v_live.region
  );

  insert into cooldowns (player_id, gamemode, until)
  values (v_live.player_id, v_live.gamemode, now() + interval '3 days')
  on conflict (player_id, gamemode) do update set until = excluded.until;

  delete from live_tests where id = p_live_test_id;
end;
$$;

-- Lets a logged-in player without a known IGN yet (shouldn't normally happen,
-- since the trigger sets one from Discord) update their in-game name/platform/region.
create or replace function set_my_profile(p_username text, p_platform text, p_region text)
returns void
language plpgsql
security definer
as $$
begin
  update players set
    username = coalesce(p_username, username),
    platform = coalesce(p_platform, platform),
    region = coalesce(p_region, region)
  where id = current_player_id();
end;
$$;

-- ============================================================
-- 8. PERMISSIONS: only logged-in users may call the action functions;
--    anonymous visitors can still read everything via the policies above.
-- ============================================================

revoke all on function join_queue, leave_queue, join_testing, leave_testing,
  set_queue_closed, claim_next, cancel_live_test, submit_result, set_my_profile
  from public;

grant execute on function join_queue, leave_queue, join_testing, leave_testing,
  set_queue_closed, claim_next, cancel_live_test, submit_result, set_my_profile
  to authenticated;

-- ============================================================
-- 9. SUPPORT TICKETS (help / report / appeal) — mirrored to Discord
--    by the bot, which listens for new rows via Realtime and posts a
--    "<discord username>-ticket" channel; it also mirrors messages both
--    ways. The web app never talks to Discord directly.
-- ============================================================

create table if not exists support_tickets (
  id bigint generated always as identity primary key,
  player_id bigint not null references players(id) on delete cascade,
  category text not null check (category in ('help', 'report', 'appeal')),
  subject text not null,
  status text not null default 'open' check (status in ('open', 'closed')),
  discord_channel_id text,
  created_at timestamptz not null default now(),
  closed_at timestamptz
);

create table if not exists support_messages (
  id bigint generated always as identity primary key,
  ticket_id bigint not null references support_tickets(id) on delete cascade,
  author_player_id bigint references players(id),
  author_label text,
  source text not null check (source in ('website', 'discord')),
  content text not null,
  created_at timestamptz not null default now()
);

alter table support_tickets enable row level security;
alter table support_messages enable row level security;

drop policy if exists "own or staff" on support_tickets;
create policy "own or staff" on support_tickets for select using (
  player_id = current_player_id() or current_is_moderator() or current_is_owner()
);

drop policy if exists "own or staff" on support_messages;
create policy "own or staff" on support_messages for select using (
  exists (
    select 1 from support_tickets t
    where t.id = ticket_id
      and (t.player_id = current_player_id() or current_is_moderator() or current_is_owner())
  )
);

-- Creates a ticket plus its first message in one go; returns the new ticket id.
create or replace function create_support_ticket(p_category text, p_subject text, p_message text)
returns bigint
language plpgsql
security definer
as $$
declare
  v_player_id bigint := current_player_id();
  v_ticket_id bigint;
begin
  if v_player_id is null then
    raise exception 'not logged in';
  end if;
  if p_category not in ('help', 'report', 'appeal') then
    raise exception 'invalid category';
  end if;

  insert into support_tickets (player_id, category, subject)
  values (v_player_id, p_category, p_subject)
  returning id into v_ticket_id;

  insert into support_messages (ticket_id, author_player_id, source, content)
  values (v_ticket_id, v_player_id, 'website', p_message);

  return v_ticket_id;
end;
$$;

create or replace function send_support_message(p_ticket_id bigint, p_content text)
returns void
language plpgsql
security definer
as $$
declare
  v_player_id bigint := current_player_id();
  v_ticket record;
begin
  select * into v_ticket from support_tickets where id = p_ticket_id;
  if v_ticket is null then
    raise exception 'ticket not found';
  end if;
  if v_ticket.player_id != v_player_id and not current_is_moderator() and not current_is_owner() then
    raise exception 'not allowed';
  end if;

  insert into support_messages (ticket_id, author_player_id, source, content)
  values (p_ticket_id, v_player_id, 'website', p_content);
end;
$$;

create or replace function close_support_ticket(p_ticket_id bigint)
returns void
language plpgsql
security definer
as $$
declare
  v_player_id bigint := current_player_id();
  v_ticket record;
begin
  select * into v_ticket from support_tickets where id = p_ticket_id;
  if v_ticket is null then
    raise exception 'ticket not found';
  end if;
  if v_ticket.player_id != v_player_id and not current_is_moderator() and not current_is_owner() then
    raise exception 'not allowed';
  end if;

  update support_tickets set status = 'closed', closed_at = now() where id = p_ticket_id;
end;
$$;

revoke all on function create_support_ticket, send_support_message, close_support_ticket from public;
grant execute on function create_support_ticket, send_support_message, close_support_ticket to authenticated;

-- ============================================================
-- 10. REALTIME — so the Queues/Results/Support subtabs update live for
--     everyone, and so the bot can react to new tickets/messages
-- ============================================================

-- ADD TABLE has no IF NOT EXISTS, and errors (aborting the rest of this
-- script) if the table's already a publication member — so re-running this
-- file a second time would otherwise silently stop here. Guard each one.
do $$
declare
  t text;
begin
  foreach t in array array[
    'queue_entries', 'queue_testers', 'queue_closed', 'live_tests',
    'test_log', 'support_tickets', 'support_messages', 'player_tiers'
  ]
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table %I', t);
    end if;
  end loop;
end $$;
