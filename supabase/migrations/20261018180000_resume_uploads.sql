-- Uploaded resumes: keep the original file and the format detected from it.

alter table public.profiles
  add column if not exists resume_format    jsonb,
  add column if not exists source_file_path text,
  add column if not exists source_file_name text;

alter table public.resumes
  add column if not exists template text not null default 'classic',
  add column if not exists format   jsonb;

-- Private bucket; each user can only touch files inside their own "<user id>/" folder.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'resume-uploads', 'resume-uploads', false, 5242880,
  array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain', 'text/markdown'
  ]
)
on conflict (id) do nothing;

create policy "resume-uploads: owner can read" on storage.objects for select
  using (bucket_id = 'resume-uploads' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "resume-uploads: owner can upload" on storage.objects for insert
  with check (bucket_id = 'resume-uploads' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "resume-uploads: owner can update" on storage.objects for update
  using (bucket_id = 'resume-uploads' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "resume-uploads: owner can delete" on storage.objects for delete
  using (bucket_id = 'resume-uploads' and (storage.foldername(name))[1] = auth.uid()::text);
