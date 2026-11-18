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

-- Placeholder destination rooms; replace these with the school's real room labels.
-- A wildcard elective mapping covers each track until elective-specific rooms are configured.
insert into public.track_room_mappings (grade, pathway, track, elective, room_label)
values
  ('*', '*', 'STEM', '*', 'Room 1'),
  ('*', '*', 'Business and Entrepreneurship', '*', 'Room 2'),
  ('*', '*', 'ASSH', '*', 'Room 3'),
  ('*', '*', 'Programming', '*', 'Room 4'),
  ('*', '*', 'Visual Graphic Design', '*', 'Room 5'),
  ('*', '*', 'Animation', '*', 'Room 6'),
  ('*', '*', 'Bakery', '*', 'Room 7')
on conflict (grade, pathway, track, elective) do nothing;

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
  progress jsonb not null default '{"documentsChecked":true,"orientationComplete":true,"brigadaComplete":true,"teacherComplete":false,"roomAssigned":false}'::jsonb,
  room_label text,
  step2_status text not null default 'WAITING' check (step2_status in ('WAITING', 'IN_SERVICE', 'DONE', 'SKIPPED')),
  step2_called_at timestamptz,
  step2_completed_at timestamptz,
  step2_skipped_at timestamptz,
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

alter table public.queue_tickets alter column progress
  set default '{"documentsChecked":true,"orientationComplete":true,"brigadaComplete":true,"teacherComplete":false,"roomAssigned":false}'::jsonb;

alter table public.queue_tickets add column if not exists step2_status text not null default 'WAITING';
alter table public.queue_tickets add column if not exists step2_called_at timestamptz;
alter table public.queue_tickets add column if not exists step2_completed_at timestamptz;
alter table public.queue_tickets add column if not exists step2_skipped_at timestamptz;
update public.queue_tickets set step2_status = 'WAITING'
where status = 'COMPLETED' and room_label is not null and step2_status is null;

create unique index if not exists queue_tickets_one_active_per_track_room
  on public.queue_tickets (session_id, room_label)
  where status = 'COMPLETED' and step2_status = 'IN_SERVICE';

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

-- Repair completed Step 1 tickets that were missing their mapped Step 2 room.
with mapped as (
  select t.id, m.room_label, coalesce(t.completed_at, t.created_at, now()) as routed_at
  from public.queue_tickets t
  cross join lateral (
    select room_label from public.track_room_mappings
    where active
      and track = t.track
      and (grade = t.grade or grade = '*')
      and (pathway = t.pathway or pathway = '*')
      and (elective = coalesce(t.elective, '*') or elective = '*')
    order by (grade = t.grade) desc, (pathway = t.pathway) desc,
      (elective = coalesce(t.elective, '*')) desc
    limit 1
  ) m
  where t.status = 'COMPLETED' and t.room_label is null
), repaired as (
  update public.queue_tickets t
  set room_label = mapped.room_label,
      progress = t.progress || jsonb_build_object(
        'teacherComplete', true,
        'teacherCompletedAt', coalesce(t.progress->>'teacherCompletedAt', mapped.routed_at::text),
        'roomAssigned', true,
        'roomAssignedAt', mapped.routed_at
      )
  from mapped
  where t.id = mapped.id
  returning t.session_id, t.id, t.public_code, t.completed_at, t.created_at
)
insert into public.queue_events (session_id, ticket_id, event_type, ticket_code, created_at)
select repaired.session_id, repaired.id, 'ROOM_ASSIGNED', repaired.public_code,
  coalesce(repaired.completed_at, repaired.created_at, now())
from repaired
where not exists (
  select 1 from public.queue_events e
  where e.ticket_id = repaired.id and e.event_type = 'ROOM_ASSIGNED'
);

-- Anonymous ticket issuance is limited by the client IP supplied by Supabase's
-- trusted edge proxy. Only a one-way digest is retained for the current day.
create table if not exists public.ticket_issue_rate_limits (
  requester_hash bytea not null,
  session_id uuid not null references public.enrollment_sessions(id) on delete cascade,
  minute_bucket timestamptz not null,
  minute_count integer not null default 0,
  hour_bucket timestamptz not null,
  hour_count integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (requester_hash, session_id),
  check (octet_length(requester_hash) = 32),
  check (minute_count >= 0 and hour_count >= 0)
);
alter table public.ticket_issue_rate_limits enable row level security;
revoke all on public.ticket_issue_rate_limits from public, anon, authenticated;

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
drop policy if exists sessions_staff_read on public.enrollment_sessions;
create policy sessions_staff_read on public.enrollment_sessions
  for select to authenticated using (public.has_staff_access());

drop policy if exists mappings_public_read on public.track_room_mappings;
drop policy if exists mappings_staff_read on public.track_room_mappings;
create policy mappings_staff_read on public.track_room_mappings
  for select to authenticated using (public.has_staff_access());

drop policy if exists tickets_public_read on public.queue_tickets;
drop policy if exists tickets_staff_read on public.queue_tickets;
create policy tickets_staff_read on public.queue_tickets
  for select to authenticated using (public.has_staff_access());

drop policy if exists events_public_read on public.queue_events;
drop policy if exists events_staff_read on public.queue_events;
create policy events_staff_read on public.queue_events
  for select to authenticated using (public.has_staff_access());

revoke all on public.staff_roles, public.enrollment_sessions, public.track_room_mappings, public.queue_tickets, public.queue_events from public, anon, authenticated;
grant select on public.enrollment_sessions, public.track_room_mappings, public.queue_tickets, public.queue_events to authenticated;
grant select on public.staff_roles to authenticated;
revoke insert, update, delete, truncate, references, trigger on public.staff_roles, public.enrollment_sessions, public.track_room_mappings, public.queue_tickets, public.queue_events from public, anon, authenticated;

create or replace function public.get_queue_snapshot(p_ticket_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_session public.enrollment_sessions%rowtype;
  v_tickets jsonb := '[]'::jsonb;
  v_events jsonb := '[]'::jsonb;
  v_is_staff boolean := public.has_staff_access();
begin
  select * into v_session from public.enrollment_sessions where is_current;
  if not found then
    return jsonb_build_object('session', null, 'tickets', v_tickets, 'events', v_events, 'rooms', '[]'::jsonb);
  end if;

  if v_is_staff then
    select coalesce(jsonb_agg(to_jsonb(t) order by t.queue_order), '[]'::jsonb)
      into v_tickets
      from public.queue_tickets t where t.session_id = v_session.id;
    select coalesce(jsonb_agg(to_jsonb(e) order by e.created_at desc), '[]'::jsonb)
      into v_events
      from (
        select e.*, t.room_label from public.queue_events e
        left join public.queue_tickets t on t.id = e.ticket_id
        where e.session_id = v_session.id order by e.created_at desc limit 100
      ) e;
  else
    select coalesce(jsonb_agg(
      case when t.id = p_ticket_id then to_jsonb(t)
      else jsonb_build_object(
        'public_code', t.public_code,
        'queue_order', t.queue_order,
        'status', t.status,
        'progress', jsonb_build_object('documentsChecked', true, 'orientationComplete', true),
        'room_label', case when t.status = 'COMPLETED' then t.room_label else null end,
        'step2_status', case when t.status = 'COMPLETED' then t.step2_status else null end
      ) end order by t.queue_order
    ), '[]'::jsonb)
      into v_tickets
      from public.queue_tickets t
      where t.session_id = v_session.id
        and (t.status in ('WAITING', 'CALLED', 'IN_SERVICE') or t.id = p_ticket_id
          or (t.status = 'COMPLETED' and t.room_label is not null and t.step2_status in ('WAITING', 'IN_SERVICE')));

    select coalesce(jsonb_agg(jsonb_build_object(
      'id', e.id,
      'event_type', e.event_type,
      'ticket_code', e.ticket_code,
      'room_label', case when e.event_type in ('ROOM_ASSIGNED', 'STEP2_TICKET_CALLED', 'STEP2_TICKET_COMPLETED', 'STEP2_TICKET_SKIPPED') then t.room_label else null end,
      'created_at', e.created_at
    ) order by e.created_at desc), '[]'::jsonb)
      into v_events
      from (
        select id, event_type, ticket_id, ticket_code, created_at
        from public.queue_events
        where session_id = v_session.id
          and event_type in ('TICKET_CALLED', 'TICKET_RECALLED', 'ROOM_ASSIGNED', 'STEP2_TICKET_CALLED', 'STEP2_TICKET_COMPLETED', 'STEP2_TICKET_SKIPPED')
        order by created_at desc limit 20
      ) e
      left join public.queue_tickets t on t.id = e.ticket_id;
  end if;

  return jsonb_build_object(
    'session', jsonb_build_object(
      'id', v_session.id,
      'name', v_session.name,
      'station', v_session.station,
      'status', v_session.status,
      'started_at', v_session.started_at
    ),
    'tickets', v_tickets,
    'events', v_events,
    'rooms', (select coalesce(jsonb_agg(distinct room_label order by room_label), '[]'::jsonb) from public.track_room_mappings where active)
  );
end;
$$;
revoke all on function public.get_queue_snapshot(uuid) from public;
grant execute on function public.get_queue_snapshot(uuid) to anon, authenticated;

-- Remove the previous signature so PostgREST cannot resolve an outdated overload.
drop function if exists public.issue_enrollment_ticket(text, text, text, boolean, boolean, text);

create or replace function public.issue_enrollment_ticket(
  p_grade text,
  p_pathway text,
  p_track text,
  p_documents_checked boolean,
  p_orientation_complete boolean,
  p_brigada_complete boolean,
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
  v_grade text := nullif(trim(p_grade), '');
  v_pathway text := nullif(trim(p_pathway), '');
  v_track text := nullif(trim(p_track), '');
  v_headers jsonb;
  v_client_ip inet;
  v_requester_hash bytea;
  v_crypto_schema text;
  v_minute_bucket timestamptz := date_trunc('minute', now());
  v_hour_bucket timestamptz := date_trunc('hour', now());
  v_rate_allowed boolean := false;
begin
  if not coalesce(p_documents_checked, false)
    or not coalesce(p_orientation_complete, false)
    or not coalesce(p_brigada_complete, false) then
    raise exception 'Document check, orientation, and Brigada must be complete before getting a ticket.' using errcode = 'P0001';
  end if;
  if v_grade is null or v_grade not in ('Grade 11', 'Grade 12')
    or v_pathway is null or v_pathway not in ('Academic track', 'TechPro')
    or v_track is null or v_track not in ('STEM', 'Business and Entrepreneurship', 'ASSH', 'Programming', 'Visual Graphic Design', 'Animation', 'Bakery') then
    raise exception 'Choose a valid grade, pathway, and track.' using errcode = 'P0001';
  end if;
  if (v_pathway = 'Academic track' and v_track not in ('STEM', 'Business and Entrepreneurship', 'ASSH'))
    or (v_pathway = 'TechPro' and v_track not in ('Programming', 'Visual Graphic Design', 'Animation', 'Bakery')) then
    raise exception 'The selected track does not belong to that pathway.' using errcode = 'P0001';
  end if;
  if nullif(trim(p_elective), '') is not null then
    raise exception 'Elective selection is not available in this kiosk.' using errcode = 'P0001';
  end if;

  select * into v_session from public.enrollment_sessions where is_current for update;
  if not found or v_session.status <> 'ACTIVE' then
    raise exception 'Ticket requests are not available right now.' using errcode = 'P0001';
  end if;

  v_headers := nullif(current_setting('request.headers', true), '')::jsonb;
  begin
    v_client_ip := nullif(btrim(coalesce(
      v_headers->>'cf-connecting-ip',
      v_headers->>'x-real-ip'
    )), '')::inet;
  exception when invalid_text_representation then
    raise exception 'Ticket requests cannot be verified right now.' using errcode = 'P0001';
  end;
  if v_client_ip is null then
    raise exception 'Ticket requests cannot be verified right now.' using errcode = 'P0001';
  end if;
  select n.nspname into v_crypto_schema
    from pg_catalog.pg_extension e
    join pg_catalog.pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'pgcrypto';
  if v_crypto_schema is null then
    raise exception 'Ticket requests cannot be verified right now.' using errcode = 'P0001';
  end if;
  execute format('select %I.digest($1, $2)', v_crypto_schema)
    into v_requester_hash
    using convert_to(v_client_ip::text, 'UTF8'), 'sha256';
  delete from public.ticket_issue_rate_limits where updated_at < now() - interval '1 day';
  insert into public.ticket_issue_rate_limits (
    requester_hash, session_id, minute_bucket, minute_count, hour_bucket, hour_count, updated_at
  ) values (
    v_requester_hash, v_session.id, v_minute_bucket, 1, v_hour_bucket, 1, now()
  )
  on conflict (requester_hash, session_id) do update set
    minute_count = case when public.ticket_issue_rate_limits.minute_bucket = excluded.minute_bucket
      then public.ticket_issue_rate_limits.minute_count + 1 else 1 end,
    minute_bucket = excluded.minute_bucket,
    hour_count = case when public.ticket_issue_rate_limits.hour_bucket = excluded.hour_bucket
      then public.ticket_issue_rate_limits.hour_count + 1 else 1 end,
    hour_bucket = excluded.hour_bucket,
    updated_at = excluded.updated_at
  where (public.ticket_issue_rate_limits.minute_bucket <> excluded.minute_bucket
      or public.ticket_issue_rate_limits.minute_count < 12)
    and (public.ticket_issue_rate_limits.hour_bucket <> excluded.hour_bucket
      or public.ticket_issue_rate_limits.hour_count < 120)
  returning true into v_rate_allowed;
  if not coalesce(v_rate_allowed, false) then
    raise exception 'Too many ticket requests. Please ask enrollment staff for help.' using errcode = 'P0001';
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
    v_session.id, v_code, v_order, v_grade, v_pathway, v_track, null,
    '{"documentsChecked":true,"orientationComplete":true,"brigadaComplete":true,"teacherComplete":false,"roomAssigned":false}'::jsonb
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
    if (p_payload ? 'name' and (nullif(trim(p_payload->>'name'), '') is null or length(trim(p_payload->>'name')) > 60))
      or (p_payload ? 'station' and (nullif(trim(p_payload->>'station'), '') is null or length(trim(p_payload->>'station')) > 60)) then
      raise exception 'Session name and station must contain 1 to 60 characters.' using errcode = 'P0001';
    end if;
    update public.enrollment_sessions
      set name = coalesce(nullif(trim(p_payload->>'name'), ''), name),
          station = coalesce(nullif(trim(p_payload->>'station'), ''), station)
      where id = v_session.id;
    return jsonb_build_object('ok', true);
  elsif p_action = 'set_session_status' then
    if coalesce(p_payload->>'status', '') not in ('ACTIVE', 'PAUSED', 'CLOSED') then
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
        and progress->>'brigadaComplete' = 'true'
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
      if coalesce(v_ticket.progress->>'brigadaComplete', 'false') <> 'true' then
        raise exception 'Complete Brigada before the Step 1 teacher meeting.' using errcode = 'P0001';
      end if;
      select * into v_mapping from public.track_room_mappings
        where active
          and track = v_ticket.track
          and (grade = v_ticket.grade or grade = '*')
          and (pathway = v_ticket.pathway or pathway = '*')
          and (elective = coalesce(v_ticket.elective, '*') or elective = '*')
        order by (grade = v_ticket.grade) desc, (pathway = v_ticket.pathway) desc,
          (elective = coalesce(v_ticket.elective, '*')) desc
        limit 1;
      if not found then raise exception 'No destination room is mapped for track: %', v_ticket.track using errcode = 'P0001'; end if;
      update public.queue_tickets set status = 'COMPLETED', completed_at = v_now,
        room_label = v_mapping.room_label,
        progress = progress || jsonb_build_object(
          'teacherComplete', true,
          'teacherCompletedAt', v_now,
          'roomAssigned', true,
          'roomAssignedAt', v_now
        )
        where id = v_ticket.id;
      insert into public.queue_events (session_id, ticket_id, event_type, ticket_code) values (v_session.id, v_ticket.id, 'TEACHER_MEETING_COMPLETED', v_ticket.public_code);
      insert into public.queue_events (session_id, ticket_id, event_type, ticket_code) values (v_session.id, v_ticket.id, 'ROOM_ASSIGNED', v_ticket.public_code);
      select * into v_next from public.queue_tickets where session_id = v_session.id and status = 'WAITING'
        and progress->>'documentsChecked' = 'true' and progress->>'orientationComplete' = 'true'
        and progress->>'brigadaComplete' = 'true'
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
        and progress->>'brigadaComplete' = 'true'
        order by queue_order limit 1 for update skip locked;
      if found then
        update public.queue_tickets set status = 'CALLED', called_at = v_now, call_count = call_count + 1 where id = v_next.id;
        insert into public.queue_events (session_id, ticket_id, event_type, ticket_code) values (v_session.id, v_next.id, 'TICKET_CALLED', v_next.public_code);
      end if;
    end if;
    return jsonb_build_object('ok', true);
  else
    raise exception 'Unknown queue action.' using errcode = 'P0001';
  end if;
end;
$$;

create or replace function public.step2_room_action(
  p_action text,
  p_room_label text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.enrollment_sessions%rowtype;
  v_current public.queue_tickets%rowtype;
  v_next public.queue_tickets%rowtype;
  v_now timestamptz := now();
begin
  if not public.has_staff_access() then
    raise exception 'Staff sign-in is required for this action.' using errcode = '42501';
  end if;
  if nullif(trim(p_room_label), '') is null or length(trim(p_room_label)) > 60 then
    raise exception 'Choose a valid track room.' using errcode = 'P0001';
  end if;
  select * into v_session from public.enrollment_sessions where is_current for update;
  if not found then raise exception 'There is no active enrollment session.' using errcode = 'P0001'; end if;

  if p_action = 'call_next' then
    if v_session.status = 'CLOSED' then raise exception 'This session is closed.' using errcode = 'P0001'; end if;
    if exists (select 1 from public.queue_tickets where session_id = v_session.id and room_label = trim(p_room_label) and status = 'COMPLETED' and step2_status = 'IN_SERVICE') then
      raise exception 'Finish or skip the current ticket in this room first.' using errcode = 'P0001';
    end if;
    select * into v_next from public.queue_tickets
      where session_id = v_session.id and room_label = trim(p_room_label)
        and status = 'COMPLETED' and step2_status = 'WAITING'
      order by queue_order limit 1 for update skip locked;
    if not found then raise exception 'No students are waiting in this room.' using errcode = 'P0001'; end if;
    update public.queue_tickets set step2_status = 'IN_SERVICE', step2_called_at = v_now
      where id = v_next.id returning * into v_next;
    insert into public.queue_events (session_id, ticket_id, event_type, ticket_code)
      values (v_session.id, v_next.id, 'STEP2_TICKET_CALLED', v_next.public_code);
    return jsonb_build_object('ok', true, 'ticket_code', v_next.public_code);
  elsif p_action in ('complete_current', 'skip_current') then
    select * into v_current from public.queue_tickets
      where session_id = v_session.id and room_label = trim(p_room_label)
        and status = 'COMPLETED' and step2_status = 'IN_SERVICE'
      for update;
    if not found then raise exception 'There is no current ticket in this room.' using errcode = 'P0001'; end if;
    if p_action = 'complete_current' then
      update public.queue_tickets set step2_status = 'DONE', step2_completed_at = v_now where id = v_current.id;
      insert into public.queue_events (session_id, ticket_id, event_type, ticket_code)
        values (v_session.id, v_current.id, 'STEP2_TICKET_COMPLETED', v_current.public_code);
      return jsonb_build_object('ok', true, 'ticket_code', v_current.public_code);
    end if;
    update public.queue_tickets set step2_status = 'SKIPPED', step2_skipped_at = v_now where id = v_current.id;
    insert into public.queue_events (session_id, ticket_id, event_type, ticket_code)
      values (v_session.id, v_current.id, 'STEP2_TICKET_SKIPPED', v_current.public_code);
    select * into v_next from public.queue_tickets
      where session_id = v_session.id and room_label = trim(p_room_label)
        and status = 'COMPLETED' and step2_status = 'WAITING'
      order by queue_order limit 1 for update skip locked;
    if found then
      update public.queue_tickets set step2_status = 'IN_SERVICE', step2_called_at = v_now where id = v_next.id;
      insert into public.queue_events (session_id, ticket_id, event_type, ticket_code)
        values (v_session.id, v_next.id, 'STEP2_TICKET_CALLED', v_next.public_code);
    end if;
    return jsonb_build_object('ok', true, 'skipped_ticket_code', v_current.public_code, 'next_ticket_code', v_next.public_code);
  else
    raise exception 'Unknown Step 2 room action.' using errcode = 'P0001';
  end if;
end;
$$;

create or replace function public.route_completed_ticket_to_step2(p_ticket_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session_id uuid;
  v_ticket public.queue_tickets%rowtype;
  v_mapping public.track_room_mappings%rowtype;
  v_now timestamptz := now();
begin
  if not public.has_staff_access() then
    raise exception 'Staff sign-in is required for this action.' using errcode = '42501';
  end if;
  select id into v_session_id from public.enrollment_sessions where is_current;
  if not found then raise exception 'There is no active enrollment session.' using errcode = 'P0001'; end if;
  select * into v_ticket from public.queue_tickets
    where id = p_ticket_id and session_id = v_session_id for update;
  if not found then raise exception 'This ticket is not part of the current session.' using errcode = 'P0001'; end if;
  if v_ticket.status <> 'COMPLETED' then
    raise exception 'Complete the Step 1 teacher meeting before routing this student.' using errcode = 'P0001';
  end if;
  if v_ticket.room_label is null or coalesce(v_ticket.progress->>'roomAssigned', 'false') <> 'true' then
    select * into v_mapping from public.track_room_mappings
      where active
        and track = v_ticket.track
        and (grade = v_ticket.grade or grade = '*')
        and (pathway = v_ticket.pathway or pathway = '*')
        and (elective = coalesce(v_ticket.elective, '*') or elective = '*')
      order by (grade = v_ticket.grade) desc, (pathway = v_ticket.pathway) desc,
        (elective = coalesce(v_ticket.elective, '*')) desc
      limit 1;
    if not found then raise exception 'No destination room is mapped for track: %', v_ticket.track using errcode = 'P0001'; end if;
    update public.queue_tickets set room_label = v_mapping.room_label,
      progress = progress || jsonb_build_object(
        'teacherComplete', true,
        'teacherCompletedAt', coalesce(progress->>'teacherCompletedAt', v_now::text),
        'roomAssigned', true,
        'roomAssignedAt', v_now
      ) where id = v_ticket.id returning * into v_ticket;
  end if;
  if not exists (select 1 from public.queue_events where ticket_id = v_ticket.id and event_type = 'ROOM_ASSIGNED') then
    insert into public.queue_events (session_id, ticket_id, event_type, ticket_code)
      values (v_session_id, v_ticket.id, 'ROOM_ASSIGNED', v_ticket.public_code);
  end if;
  return jsonb_build_object('ok', true, 'room_label', v_ticket.room_label);
end;
$$;

revoke all on function public.issue_enrollment_ticket(text, text, text, boolean, boolean, boolean, text) from public;
revoke all on function public.staff_queue_action(text, uuid, jsonb) from public;
revoke all on function public.step2_room_action(text, text) from public;
revoke all on function public.route_completed_ticket_to_step2(uuid) from public;
grant execute on function public.issue_enrollment_ticket(text, text, text, boolean, boolean, boolean, text) to anon, authenticated;
grant execute on function public.staff_queue_action(text, uuid, jsonb) to authenticated;
grant execute on function public.step2_room_action(text, text) to authenticated;
grant execute on function public.route_completed_ticket_to_step2(uuid) to authenticated;
notify pgrst, 'reload schema';

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
