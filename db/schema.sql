create extension if not exists pgcrypto;

create table if not exists public.sessions (
  id            uuid primary key default gen_random_uuid(),
  player_name   text        not null,
  ip_hash       text        not null,
  created_at    timestamptz not null default now(),
  completed_at  timestamptz,
  -- open | verified | rejected | abandoned
  status        text        not null default 'open',
  median_ms     numeric(8,2),
  best_ms       numeric(8,2),
  sd_ms         numeric(8,2),
  flags         jsonb       not null default '[]'::jsonb,
  client_report jsonb       not null default '{}'::jsonb
);

create table if not exists public.rounds (
  id                uuid primary key default gen_random_uuid(),
  session_id        uuid        not null references public.sessions(id) on delete cascade,
  idx               int         not null,
  -- the delay is written only AFTER it has elapsed; it is never sent to the client
  delay_ms          int         not null,
  go_sent_at        timestamptz not null,
  result_at         timestamptz,
  reported_ms       numeric(8,2),
  -- measured entirely on the server: go_sent_at -> result arrival
  server_elapsed_ms numeric(8,2),
  -- pending | valid | void
  status            text        not null default 'pending',
  note              text,
  unique (session_id, idx)
);

create index if not exists sessions_board_idx  on public.sessions (status, median_ms);
create index if not exists sessions_rate_idx   on public.sessions (ip_hash, created_at desc);
-- Whose fault a void was: 'network' (the wire was slow, nothing the player
-- did) or 'player'. Added separately because "create table if not exists"
-- will not add a column to a table that already exists.
alter table public.rounds add column if not exists fault text;

create index if not exists rounds_session_idx  on public.rounds (session_id, idx);
