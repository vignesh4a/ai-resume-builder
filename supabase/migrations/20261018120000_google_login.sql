-- Google sign-in: store each user's identity, their login history and their saved inputs.

alter table public.profiles
  add column if not exists email         text,
  add column if not exists full_name     text,
  add column if not exists avatar_url    text,
  add column if not exists provider      text,
  add column if not exists draft_requirement text not null default '',
  add column if not exists created_at    timestamptz not null default now(),
  add column if not exists last_login_at timestamptz,
  add column if not exists login_count   integer not null default 0;

create table if not exists public.login_events (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references auth.users (id) on delete cascade,
  email        text,
  provider     text,
  user_agent   text,
  logged_in_at timestamptz not null default now()
);

create index if not exists login_events_user_idx on public.login_events (user_id, logged_in_at desc);

alter table public.login_events enable row level security;
create policy "login_events: owner can read" on public.login_events for select using (auth.uid() = user_id);

-- Copy identity details from auth.users into a profile row.
create or replace function public.sync_profile_from_auth(u auth.users)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.profiles (user_id, email, full_name, avatar_url, provider)
  values (
    u.id,
    u.email,
    coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name'),
    coalesce(u.raw_user_meta_data ->> 'avatar_url', u.raw_user_meta_data ->> 'picture'),
    u.raw_app_meta_data ->> 'provider'
  )
  on conflict (user_id) do update set
    email      = excluded.email,
    full_name  = coalesce(excluded.full_name, public.profiles.full_name),
    avatar_url = coalesce(excluded.avatar_url, public.profiles.avatar_url),
    provider   = coalesce(excluded.provider, public.profiles.provider);
$$;

create or replace function public.handle_auth_user_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.sync_profile_from_auth(new);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert or update of email, raw_user_meta_data on auth.users
  for each row execute function public.handle_auth_user_change();

-- Called by the website right after a sign-in. Records the login and refreshes the profile.
create or replace function public.record_login(user_agent text default null)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  u auth.users;
  p public.profiles;
begin
  select * into u from auth.users where id = auth.uid();
  if u.id is null then
    raise exception 'Not signed in';
  end if;

  perform public.sync_profile_from_auth(u);

  insert into public.login_events (user_id, email, provider, user_agent)
  values (u.id, u.email, u.raw_app_meta_data ->> 'provider', left(user_agent, 300));

  update public.profiles
     set last_login_at = now(), login_count = login_count + 1
   where user_id = u.id
  returning * into p;

  return p;
end;
$$;

revoke all on function public.record_login(text) from public, anon;
grant execute on function public.record_login(text) to authenticated;
revoke all on function public.sync_profile_from_auth(auth.users) from public, anon, authenticated;

-- Backfill profiles for users who signed up before this migration.
insert into public.profiles (user_id, email, full_name, avatar_url, provider)
select id, email,
       coalesce(raw_user_meta_data ->> 'full_name', raw_user_meta_data ->> 'name'),
       coalesce(raw_user_meta_data ->> 'avatar_url', raw_user_meta_data ->> 'picture'),
       raw_app_meta_data ->> 'provider'
  from auth.users
on conflict (user_id) do nothing;
