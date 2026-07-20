-- Max 3 cloud projects per user (local .CMF files are unlimited)
create or replace function public.enforce_cloud_project_limit()
returns trigger
language plpgsql
as $$
declare
  project_count integer;
begin
  select count(*)::integer into project_count
  from public.projects
  where user_id = new.user_id;

  if project_count >= 3 then
    raise exception 'Limite di 3 progetti cloud raggiunto. Salva in locale (.CMF).'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists projects_enforce_cloud_limit on public.projects;
create trigger projects_enforce_cloud_limit
  before insert on public.projects
  for each row
  execute function public.enforce_cloud_project_limit();
