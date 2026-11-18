-- Add a FIFO Step 2 service queue for each mapped track room.
alter table public.queue_tickets
  add column if not exists step2_status text not null default 'WAITING';
alter table public.queue_tickets
  add column if not exists step2_called_at timestamptz;
alter table public.queue_tickets
  add column if not exists step2_completed_at timestamptz;
alter table public.queue_tickets
  add column if not exists step2_skipped_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'queue_tickets_step2_status_check'
      and conrelid = 'public.queue_tickets'::regclass
  ) then
    alter table public.queue_tickets add constraint queue_tickets_step2_status_check
      check (step2_status in ('WAITING', 'IN_SERVICE', 'DONE', 'SKIPPED'));
  end if;
end;
$$;

create unique index if not exists queue_tickets_one_active_per_track_room
  on public.queue_tickets (session_id, room_label)
  where status = 'COMPLETED' and step2_status = 'IN_SERVICE';

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
  if not found then return jsonb_build_object('session', null, 'tickets', v_tickets, 'events', v_events, 'rooms', '[]'::jsonb); end if;

  if v_is_staff then
    select coalesce(jsonb_agg(to_jsonb(t) order by t.queue_order), '[]'::jsonb)
      into v_tickets from public.queue_tickets t where t.session_id = v_session.id;
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
      into v_tickets from public.queue_tickets t
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
      into v_events from (
        select id, event_type, ticket_id, ticket_code, created_at
        from public.queue_events where session_id = v_session.id
          and event_type in ('TICKET_CALLED', 'TICKET_RECALLED', 'ROOM_ASSIGNED', 'STEP2_TICKET_CALLED', 'STEP2_TICKET_COMPLETED', 'STEP2_TICKET_SKIPPED')
        order by created_at desc limit 40
      ) e left join public.queue_tickets t on t.id = e.ticket_id;
  end if;

  return jsonb_build_object(
    'session', jsonb_build_object('id', v_session.id, 'name', v_session.name, 'station', v_session.station, 'status', v_session.status, 'started_at', v_session.started_at),
    'tickets', v_tickets,
    'events', v_events,
    'rooms', (select coalesce(jsonb_agg(distinct room_label order by room_label), '[]'::jsonb) from public.track_room_mappings where active)
  );
end;
$$;
revoke all on function public.get_queue_snapshot(uuid) from public;
grant execute on function public.get_queue_snapshot(uuid) to anon, authenticated;

create or replace function public.step2_room_action(p_action text, p_room_label text)
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

revoke all on function public.step2_room_action(text, text) from public;
grant execute on function public.step2_room_action(text, text) to authenticated;
notify pgrst, 'reload schema';
