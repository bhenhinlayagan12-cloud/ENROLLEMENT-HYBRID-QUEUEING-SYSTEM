-- Step 2 only directs students to the track room; the teacher there assigns the classroom.
-- Remove the unused classroom-entry action from the earlier draft, if it was installed.
drop function if exists public.assign_student_classroom(uuid, text);

-- Repair completed Step 1 tickets that do not yet have their mapped track room.
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

revoke all on function public.route_completed_ticket_to_step2(uuid) from public;
grant execute on function public.route_completed_ticket_to_step2(uuid) to authenticated;
notify pgrst, 'reload schema';
