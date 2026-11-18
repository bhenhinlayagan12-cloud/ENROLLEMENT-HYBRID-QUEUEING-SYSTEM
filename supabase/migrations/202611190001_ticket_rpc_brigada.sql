-- Upgrade the ticket issuing RPC to require document, orientation, and Brigada completion.
-- Run this once in the Enrollment Queue project's Supabase SQL Editor.

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
-- Remove the previous signature so PostgREST cannot resolve an outdated overload.
drop function if exists public.issue_enrollment_ticket(text, text, text, boolean, boolean, text);
drop function if exists public.issue_enrollment_ticket(text, text, text, boolean, boolean, boolean, text);

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
revoke all on function public.issue_enrollment_ticket(text, text, text, boolean, boolean, boolean, text) from public;
grant execute on function public.issue_enrollment_ticket(text, text, text, boolean, boolean, boolean, text) to anon, authenticated;
notify pgrst, 'reload schema';
