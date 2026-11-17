-- Enroll queue: shared Supabase schema
-- Apply this file in Supabase SQL Editor before adding the project URL/key to supabase-config.js.

create extension if not exists pgcrypto;

create table if not exists public.staff_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('staff', 'admin')),
  created_at timestamptz not null default now()
);

create table if not exists public.enrollment_sessions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  station text not null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'PAUSED', 'CLOSED')),
  is_current boolean not null default false,
  started_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create unique index if not exists enrollment_sessions_one_current
  on public.enrollment_sessions (is_current) where is_current;

create table if not exists public.track_room_mappings (
  id uuid primary key default gen_random_uuid(),
  grade text not null default '*',
  pathway text not null default '*',
  track text not null,
  elective text not null default '*',
  room_label text not null,
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  unique (grade, pathway, track, elective)
);

create table if not exists public.queue_tickets (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.enrollment_sessions(id) on delete cascade,
  public_code text not null unique,
  queue_order integer not null,
  status text not null default 'WAITING' check (status in ('WAITING', 'CALLED', 'IN_SERVICE', 'COMPLETED', 'SKIPPED', 'CANCELLED')),
  grade text not null,
  pathway text not null,
  track text not null,
  elective text,
  progress jsonb not null default '{"documentsChecked":true,"orientationComplete":true,"teacherComplete":false,"brigadaComplete":false,"roomAssigned":false}'::jsonb,
  room_label text,
  call_count integer not null default 0,
  created_at timestamptz not null default now(),
  called_at timestamptz,
  service_started_at timestamptz,
  completed_at timestamptz,
  skipped_at timestamptz,
  unique (session_id, queue_order)
);

create unique index if not exists queue_tickets_one_active_teacher
  on public.queue_tickets (session_id)
  where status in ('CALLED', 'IN_SERVICE');

create index if not exists queue_tickets_session_order
  on public.queue_tickets (session_id, queue_order);

create table if not exists public.queue_events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.enrollment_sessions(id) on delete cascade,
  ticket_id uuid references public.queue_tickets(id) on delete set null,
  event_type text not null,
  ticket_code text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists queue_events_session_recent
  on public.queue_events (session_id, created_at desc);

insert into public.enrollment_sessions (name, station, status, is_current)
select 'Enrollment — Morning Session', 'Step 1 — Teacher Station', 'ACTIVE', true
where not exists (select 1 from public.enrollment_sessions where is_current);

create or replace function public.has_staff_access()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.staff_roles
    where user_id = auth.uid()
  );
$$;

create or replace function public.get_my_staff_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select role from public.staff_roles where user_id = auth.uid();
$$;

create or replace function public.has_admin_access()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.staff_roles
    where user_id = auth.uid() and role = 'admin'
  );
$$;

revoke all on function public.has_staff_access() from public;
revoke all on function public.get_my_staff_role() from public;
revoke all on function public.has_admin_access() from public;
grant execute on function public.has_staff_access() to anon, authenticated;
grant execute on function public.get_my_staff_role() to authenticated;
grant execute on function public.has_admin_access() to authenticated;

alter table public.staff_roles enable row level security;
alter table public.enrollment_sessions enable row level security;
alter table public.track_room_mappings enable row level security;
alter table public.queue_tickets enable row level security;
alter table public.queue_events enable row level security;

drop policy if exists staff_roles_read_self on public.staff_roles;
create policy staff_roles_read_self on public.staff_roles
  for select to authenticated using (user_id = auth.uid());

drop policy if exists sessions_public_read on public.enrollment_sessions;
create policy sessions_public_read on public.enrollment_sessions
  for select to anon, authenticated using (is_current or public.has_staff_access());

drop policy if exists mappings_public_read on public.track_room_mappings;
create policy mappings_public_read on public.track_room_mappings
  for select to anon, authenticated using (active or public.has_staff_access());

drop policy if exists tickets_public_read on public.queue_tickets;
create policy tickets_public_read on public.queue_tickets
  for select to anon, authenticated using (
    session_id in (select id from public.enrollment_sessions where is_current)
    or public.has_staff_access()
  );

drop policy if exists events_public_read on public.queue_events;
create policy events_public_read on public.queue_events
  for select to anon, authenticated using (
    session_id in (select id from public.enrollment_sessions where is_current)
    or public.has_staff_access()
  );

grant select on public.enrollment_sessions to anon, authenticated;
grant select on public.track_room_mappings to anon, authenticated;
grant select on public.queue_tickets to anon, authenticated;
grant select on public.queue_events to anon, authenticated;
grant select on public.staff_roles to authenticated;
revoke insert, update, delete, truncate, references, trigger on public.staff_roles, public.enrollment_sessions, public.track_room_mappings, public.queue_tickets, public.queue_events from anon, authenticated;

create or replace function public.issue_enrollment_ticket(
  p_grade text,
  p_pathway text,
  p_track text,
  p_documents_checked boolean,
  p_orientation_complete boolean,
  p_elective text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.enrollment_sessions%rowtype;
  v_ticket public.queue_tickets%rowtype;
  v_code text;
  v_order integer;
  v_attempt integer;
begin
  if not coalesce(p_documents_checked, false) or not coalesce(p_orientation_complete, false) then
    raise exception 'Document check and orientation must be complete before getting a ticket.' using errcode = 'P0001';
  end if;
  if nullif(trim(p_grade), '') is null or nullif(trim(p_pathway), '') is null or nullif(trim(p_track), '') is null then
    raise exception 'Grade, pathway, and track are required.' using errcode = 'P0001';
  end if;

  select * into v_session from public.enrollment_sessions where is_current for update;
  if not found or v_session.status <> 'ACTIVE' then
    raise exception 'Ticket requests are not available right now.' using errcode = 'P0001';
  end if;

  select coalesce(max(queue_order), 0) + 1 into v_order
  from public.queue_tickets where session_id = v_session.id;

  for v_attempt in 1..30 loop
    v_code := 'EN-' || lpad((100000 + floor(random() * 900000)::integer)::text, 6, '0');
    exit when not exists (select 1 from public.queue_tickets where public_code = v_code);
    v_code := null;
  end loop;
  if v_code is null then
    raise exception 'Could not create a unique ticket number. Please try again.' using errcode = 'P0001';
  end if;

  insert into public.queue_tickets (
    session_id, public_code, queue_order, grade, pathway, track, elective, progress
  ) values (
    v_session.id, v_code, v_order, trim(p_grade), trim(p_pathway), trim(p_track), nullif(trim(p_elective), ''),
    '{"documentsChecked":true,"orientationComplete":true,"teacherComplete":false,"brigadaComplete":false,"roomAssigned":false}'::jsonb
  ) returning * into v_ticket;

  insert into public.queue_events (session_id, ticket_id, event_type, ticket_code)
  values (v_session.id, v_ticket.id, 'TICKET_CREATED', v_ticket.public_code);

  return to_jsonb(v_ticket);
end;
$$;

create or replace function public.staff_queue_action(
  p_action text,
  p_ticket_id uuid default null,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.enrollment_sessions%rowtype;
  v_ticket public.queue_tickets%rowtype;
  v_next public.queue_tickets%rowtype;
  v_mapping public.track_room_mappings%rowtype;
  v_now timestamptz := now();
begin
  if not public.has_staff_access() then
    raise exception 'Staff sign-in is required for this action.' using errcode = '42501';
  end if;
  if p_action in ('update_session', 'set_session_status') and not public.has_admin_access() then
    raise exception 'Administrator access is required for session settings.' using errcode = '42501';
  end if;

  select * into v_session from public.enrollment_sessions where is_current for update;
  if not found then raise exception 'There is no active enrollment session.' using errcode = 'P0001'; end if;

  if p_action = 'update_session' then
    update public.enrollment_sessions
      set name = coalesce(nullif(trim(p_payload->>'name'), ''), name),
          station = coalesce(nullif(trim(p_payload->>'station'), ''), station)
      where id = v_session.id;
    return jsonb_build_object('ok', true);
  elsif p_action = 'set_session_status' then
    if p_payload->>'status' not in ('ACTIVE', 'PAUSED', 'CLOSED') then
      raise exception 'Invalid session status.' using errcode = 'P0001';
    end if;
    if p_payload->>'status' = 'CLOSED' and exists (
      select 1 from public.queue_tickets where session_id = v_session.id and status in ('CALLED', 'IN_SERVICE')
    ) then
      raise exception 'Complete or skip the ticket at the counter before closing the session.' using errcode = 'P0001';
    end if;
    update public.enrollment_sessions set status = p_payload->>'status' where id = v_session.id;
    insert into public.queue_events (session_id, event_type) values (v_session.id, 'SESSION_' || (p_payload->>'status'));
    return jsonb_build_object('ok', true);
  elsif p_action = 'call_next' then
    if v_session.status = 'CLOSED' then raise exception 'This session is closed.' using errcode = 'P0001'; end if;
    if exists (select 1 from public.queue_tickets where session_id = v_session.id and status in ('CALLED', 'IN_SERVICE')) then
      raise exception 'Finish or skip the ticket at the counter first.' using errcode = 'P0001';
    end if;
    select * into v_next from public.queue_tickets
      where session_id = v_session.id and status = 'WAITING'
        and progress->>'documentsChecked' = 'true' and progress->>'orientationComplete' = 'true'
      order by queue_order limit 1 for update skip locked;
    if not found then raise exception 'No one is waiting right now.' using errcode = 'P0001'; end if;
    update public.queue_tickets set status = 'CALLED', called_at = v_now, call_count = call_count + 1
      where id = v_next.id returning * into v_next;
    insert into public.queue_events (session_id, ticket_id, event_type, ticket_code)
      values (v_session.id, v_next.id, 'TICKET_CALLED', v_next.public_code);
    return jsonb_build_object('ok', true, 'ticket_id', v_next.id);
  elsif p_action in ('start_service', 'complete_teacher', 'recall', 'skip_current') then
    select * into v_ticket from public.queue_tickets
      where session_id = v_session.id and status in ('CALLED', 'IN_SERVICE') for update;
    if not found then raise exception 'There is no current teacher ticket.' using errcode = 'P0001'; end if;

    if p_action = 'start_service' then
      if v_ticket.status <> 'CALLED' then raise exception 'This ticket has already started service.' using errcode = 'P0001'; end if;
      update public.queue_tickets set status = 'IN_SERVICE', service_started_at = v_now where id = v_ticket.id;
      insert into public.queue_events (session_id, ticket_id, event_type, ticket_code) values (v_session.id, v_ticket.id, 'SERVICE_STARTED', v_ticket.public_code);
    elsif p_action = 'complete_teacher' then
      if v_ticket.status <> 'IN_SERVICE' then raise exception 'Start the teacher meeting before completing it.' using errcode = 'P0001'; end if;
      update public.queue_tickets set status = 'COMPLETED', completed_at = v_now,
        progress = progress || jsonb_build_object('teacherComplete', true, 'teacherCompletedAt', v_now)
        where id = v_ticket.id;
      insert into public.queue_events (session_id, ticket_id, event_type, ticket_code) values (v_session.id, v_ticket.id, 'TEACHER_MEETING_COMPLETED', v_ticket.public_code);
      select * into v_next from public.queue_tickets where session_id = v_session.id and status = 'WAITING'
        and progress->>'documentsChecked' = 'true' and progress->>'orientationComplete' = 'true'
        order by queue_order limit 1 for update skip locked;
      if found then
        update public.queue_tickets set status = 'CALLED', called_at = v_now, call_count = call_count + 1 where id = v_next.id;
        insert into public.queue_events (session_id, ticket_id, event_type, ticket_code) values (v_session.id, v_next.id, 'TICKET_CALLED', v_next.public_code);
      end if;
    elsif p_action = 'recall' then
      update public.queue_tickets set called_at = v_now, call_count = call_count + 1 where id = v_ticket.id;
      insert into public.queue_events (session_id, ticket_id, event_type, ticket_code) values (v_session.id, v_ticket.id, 'TICKET_RECALLED', v_ticket.public_code);
    else
      if v_ticket.status <> 'CALLED' then raise exception 'Only a called ticket can be marked as a no-show.' using errcode = 'P0001'; end if;
      update public.queue_tickets set status = 'SKIPPED', skipped_at = v_now where id = v_ticket.id;
      insert into public.queue_events (session_id, ticket_id, event_type, ticket_code) values (v_session.id, v_ticket.id, 'TICKET_SKIPPED', v_ticket.public_code);
      select * into v_next from public.queue_tickets where session_id = v_session.id and status = 'WAITING'
        and progress->>'documentsChecked' = 'true' and progress->>'orientationComplete' = 'true'
        order by queue_order limit 1 for update skip locked;
      if found then
        update public.queue_tickets set status = 'CALLED', called_at = v_now, call_count = call_count + 1 where id = v_next.id;
        insert into public.queue_events (session_id, ticket_id, event_type, ticket_code) values (v_session.id, v_next.id, 'TICKET_CALLED', v_next.public_code);
      end if;
    end if;
    return jsonb_build_object('ok', true);
  elsif p_action = 'complete_brigada' then
    select * into v_ticket from public.queue_tickets where id = p_ticket_id and session_id = v_session.id for update;
    if not found or v_ticket.progress->>'teacherComplete' <> 'true' or v_ticket.progress->>'brigadaComplete' = 'true' then
      raise exception 'This ticket is not ready for Brigada sign-off.' using errcode = 'P0001';
    end if;
    update public.queue_tickets set progress = progress || jsonb_build_object('brigadaComplete', true, 'brigadaCompletedAt', v_now)
      where id = v_ticket.id;
    insert into public.queue_events (session_id, ticket_id, event_type, ticket_code) values (v_session.id, v_ticket.id, 'BRIGADA_COMPLETED', v_ticket.public_code);
    return jsonb_build_object('ok', true);
  elsif p_action = 'assign_room' then
    select * into v_ticket from public.queue_tickets where id = p_ticket_id and session_id = v_session.id for update;
    if not found or v_ticket.progress->>'brigadaComplete' <> 'true' or v_ticket.progress->>'roomAssigned' = 'true' then
      raise exception 'This ticket is not ready for room assignment.' using errcode = 'P0001';
    end if;
    if exists (
      select 1 from public.queue_tickets earlier
      where earlier.session_id = v_session.id and earlier.progress->>'brigadaComplete' = 'true'
        and coalesce(earlier.progress->>'roomAssigned', 'false') <> 'true'
        and (coalesce(nullif(earlier.progress->>'brigadaCompletedAt', '')::timestamptz, earlier.created_at), earlier.queue_order)
          < (coalesce(nullif(v_ticket.progress->>'brigadaCompletedAt', '')::timestamptz, v_ticket.created_at), v_ticket.queue_order)
    ) then raise exception 'Please assign the earlier eligible ticket first.' using errcode = 'P0001'; end if;
    select * into v_mapping from public.track_room_mappings
      where active
        and track = v_ticket.track
        and (grade = v_ticket.grade or grade = '*')
        and (pathway = v_ticket.pathway or pathway = '*')
        and (elective = coalesce(v_ticket.elective, '*') or elective = '*')
      order by (grade = v_ticket.grade) desc, (pathway = v_ticket.pathway) desc,
        (elective = coalesce(v_ticket.elective, '*')) desc
      limit 1;
    if not found then raise exception 'No room is mapped to track: %', v_ticket.track using errcode = 'P0001'; end if;
    update public.queue_tickets set room_label = v_mapping.room_label,
      progress = progress || jsonb_build_object('roomAssigned', true, 'roomAssignedAt', v_now)
      where id = v_ticket.id;
    insert into public.queue_events (session_id, ticket_id, event_type, ticket_code) values (v_session.id, v_ticket.id, 'ROOM_ASSIGNED', v_ticket.public_code);
    return jsonb_build_object('ok', true, 'room_label', v_mapping.room_label);
  else
    raise exception 'Unknown queue action.' using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function public.issue_enrollment_ticket(text, text, text, boolean, boolean, text) from public;
revoke all on function public.staff_queue_action(text, uuid, jsonb) from public;
grant execute on function public.issue_enrollment_ticket(text, text, text, boolean, boolean, text) to anon, authenticated;
grant execute on function public.staff_queue_action(text, uuid, jsonb) to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'enrollment_sessions') then
      execute 'alter publication supabase_realtime add table public.enrollment_sessions';
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'queue_tickets') then
      execute 'alter publication supabase_realtime add table public.queue_tickets';
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'queue_events') then
      execute 'alter publication supabase_realtime add table public.queue_events';
    end if;
  end if;
end;
$$;
