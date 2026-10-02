-- CLARUS recording app: storage bucket + RLS policies.
-- Run once in Supabase Dashboard -> SQL Editor. Safe to re-run.

-- 1. Private bucket. 10 MB per file is plenty (~0.6 MB per 12 s clip).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'recordings', 'recordings', false, 10485760,
  array['video/webm', 'video/mp4', 'application/json']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 2. Anonymous participants may upload into this bucket only.
drop policy if exists "clarus anon insert" on storage.objects;
create policy "clarus anon insert"
on storage.objects for insert
to anon
with check (bucket_id = 'recordings');

-- 3. Upload with upsert: true runs INSERT ... ON CONFLICT DO UPDATE, so an
--    UPDATE policy is required too. Without it, uploads fail with
--    "new row violates row-level security policy".
drop policy if exists "clarus anon update" on storage.objects;
create policy "clarus anon update"
on storage.objects for update
to anon
using (bucket_id = 'recordings')
with check (bucket_id = 'recordings');

-- 4. Overwriting an EXISTING file (a re-record) also needs SELECT on the old row.
--    Per the Supabase docs, upsert needs INSERT + SELECT + UPDATE. This policy is
--    restricted to the upload operation itself, so anon still CANNOT list,
--    download or sign URLs for anyone's videos.
drop policy if exists "clarus anon select during upload only" on storage.objects;
create policy "clarus anon select during upload only"
on storage.objects for select
to anon
using (
  bucket_id = 'recordings'
  and storage.allow_any_operation(array['storage.object.upload', 'storage.object.upload_update'])
);

-- No DELETE policy for anon. You (the team) view and download files from the
-- dashboard, which bypasses RLS.

-- Handy query: see every clip with its metadata.
-- select name, created_at, updated_at, user_metadata
-- from storage.objects where bucket_id = 'recordings' order by name;
