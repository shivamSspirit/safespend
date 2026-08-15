create table if not exists public.safespend_state (
  state_key text primary key check (
    length(state_key) between 1 and 160
    and state_key ~ '^[a-z0-9][a-z0-9/_-]*$'
  ),
  state_value jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.safespend_state enable row level security;
revoke all on table public.safespend_state from anon, authenticated;
grant select, insert, update on table public.safespend_state to service_role;
