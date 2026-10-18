-- Schema for AI Resume Builder.
-- Every row belongs to an auth user; Row Level Security keeps users isolated.

create table if not exists public.profiles (
  user_id    uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  background text not null default '',
  updated_at timestamptz not null default now()
);

create table if not exists public.resumes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title       text not null default 'Untitled resume',
  requirement text not null,
  background  text not null,
  content     jsonb not null,
  model       text,
  created_at  timestamptz not null default now()
);

create index if not exists resumes_user_created_idx on public.resumes (user_id, created_at desc);

alter table public.profiles enable row level security;
alter table public.resumes  enable row level security;

create policy "profiles: owner can read"   on public.profiles for select using (auth.uid() = user_id);
create policy "profiles: owner can insert" on public.profiles for insert with check (auth.uid() = user_id);
create policy "profiles: owner can update" on public.profiles for update using (auth.uid() = user_id);

create policy "resumes: owner can read"   on public.resumes for select using (auth.uid() = user_id);
create policy "resumes: owner can insert" on public.resumes for insert with check (auth.uid() = user_id);
create policy "resumes: owner can update" on public.resumes for update using (auth.uid() = user_id);
create policy "resumes: owner can delete" on public.resumes for delete using (auth.uid() = user_id);
