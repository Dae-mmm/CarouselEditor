-- If you already ran 001_projects.sql before aspect_ratio existed, run this too.
alter table public.projects
  add column if not exists aspect_ratio text not null default '1:1';
