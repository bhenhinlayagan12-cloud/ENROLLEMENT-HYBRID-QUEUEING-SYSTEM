# Enroll — Enrollment queue

A responsive enrollment queue app with a student ticket kiosk, staff queue dashboard, admin session controls, and separate Step 1 and Step 2 public displays. It can run as a local demo or use one shared Supabase database so separate devices see the same queue.

## Design documents

- [Role flowcharts](./Enrollment_Role_Flowcharts.drawio) — four editable pages for Admin, Teacher, Staff, and Student / Parent, using standard flowchart symbols.
- [System architecture](./Enrollment_System_Architecture.drawio) — standalone editable architecture diagram. Dashed elements mark integrations not wired in the current app.
- [Combined Draw.io file](./docs/enrollment-system-diagrams.drawio) — the same five diagrams in one file.
- [Low-fidelity sketch wireframes](./docs/enrollment-wireframes-figma.svg) — editable vector artwork for the Figma canvas, covering all 16 student, public display, staff, admin, and error screens.
- [Wireframe preview](./docs/wireframes.html) · [SVG generator](./docs/generate_wireframes.py)

## Supabase connection setup

The app is configured to use the Enrollment Queue Supabase project. Local password setup returns to `http://localhost:4173/?view=password`. In Supabase Authentication → URL Configuration, set the Site URL to the app's current base URL and add the matching password-page URL to Redirect URLs. For local use, allow `http://localhost:4173/**`; avoid mixing `127.0.0.1` and `localhost`. For a hosted app, set Site URL to its deployed origin and allow that origin's `/**` path.

The password link uses the app's current origin and the `view=password` route. If the email still opens another app, check that this project’s Site URL points to Enroll and that the recovery template honors the requested redirect. The standard `{{ .ConfirmationURL }}` link works with Supabase verification; a custom template should use `{{ .RedirectTo }}` instead of hard-coding `{{ .SiteURL }}` as its destination.

1. Create a dedicated Supabase project for this enrollment app.
2. In the Supabase SQL Editor, run [`supabase/schema.sql`](./supabase/schema.sql). It creates the queue tables, RLS policies, ticket-issuing and staff-action functions, and live-update publication entries.
   If upgrading an existing database, finish or otherwise reconcile tickets already waiting under the old preparation flow before applying the update. New Step 1 calls require the Brigada preparation check.
   If the kiosk shows `Could not find the function public.issue_enrollment_ticket(...) in the schema cache`, run [`supabase/migrations/202611190001_ticket_rpc_brigada.sql`](./supabase/migrations/202611190001_ticket_rpc_brigada.sql) in the SQL Editor. It installs the current seven-argument ticket RPC and asks PostgREST to refresh its schema cache without modifying existing queue tickets.
3. Create staff accounts in Supabase Authentication. Add each staff user's Auth UUID to `public.staff_roles` in the SQL Editor. Give at least one trusted account the `admin` role:

   ```sql
   insert into public.staff_roles (user_id, role)
   values ('AUTH-USER-UUID', 'admin')
   on conflict (user_id) do update set role = excluded.role;
   ```

4. Set the destination room for each track/elective in `public.track_room_mappings`. The schema inserts placeholder Rooms 1–7 for STEM, Business and Entrepreneurship (BE), ASSH, Programming, Visual Graphic Design, Animation, and Bakery. Replace those placeholders with the school's rooms, or add elective-specific rows; the kiosk currently captures track but does not ask for a separate elective:

   ```sql
   insert into public.track_room_mappings (grade, pathway, track, elective, room_label)
   values ('*', '*', 'STEM', '*', 'Room 1');
   ```

5. Copy the Supabase Project URL and **publishable key** into [`supabase-config.js`](./supabase-config.js). Do not use a secret or service-role key in this browser app.
6. Serve this folder over HTTP (not by opening `index.html` as a file):

   ```powershell
   python -m http.server 4173
   ```

   Open `http://localhost:4173`. Use `/?view=ticket` for the kiosk, `/?view=dashboard` for the Step 1 staff queue, `/?view=room-queue&room=Room%201` for the Step 2 staff queue, `/?view=display` for the Step 1 teacher display, and `/?view=display-step2&room=Room%201` for that room's public display. Staff pages require a signed-in account with an assigned role. The student kiosk and both displays are public.

## Queue workflow

- Document check, orientation, and the Brigada slip are part of preparation and must be completed before the Step 1 ticket is issued. The public kiosk records the student's or parent's confirmation; it does not independently verify these items.
- Tickets receive their arrival number in the database, so issuance order is shared across kiosks.
- Step 1 is the teacher meeting. Staff can call, start, recall, complete, or skip its ticket.
- After Step 1, the database maps the selected track to its configured room. The kiosk ticket and Step 2 public display tell the student or parent where to go. The teacher in that room assigns the classroom outside this app.
- For an existing Supabase project, apply `supabase/migrations/202611190002_step2_track_room_routing.sql` to repair completed tickets missing a track room and keep future Step 1 completions routed. This migration removes the unused classroom-entry RPC from the earlier draft.
- Step 2 room staff use the room queue to call the next ticket in original ticket order, complete service, or mark a no-show. The room-specific public display shows the active ticket. Apply `supabase/migrations/202611190003_step2_room_queue.sql` to enable this shared, database-locked queue.
- The Step 1 public display shows the teacher call. The separate Step 2 public display announces the ticket code and destination room after the teacher meeting is completed.
- Supabase Realtime refreshes signed-in staff views. Both public displays poll a limited queue snapshot every five seconds.

## Security boundaries

- If this Supabase project is already set up, run the updated [`supabase/schema.sql`](./supabase/schema.sql) in its SQL Editor before publishing the changed app. The database policies and functions do not change until that script is applied.
- Staff sign in through Supabase Auth. Database roles distinguish `staff` from `admin`; staff can manage tickets, while session settings require `admin`. Students do not have accounts in this app: the ticket kiosk is intentionally public.
- Anonymous pages call `get_queue_snapshot`, which returns public ticket codes, order, and status. The public snapshot also includes recent Step 2 track-room routes (ticket code and room label only) for the room display. Ticket rows, grade/track choices, detailed progress, and queue history are available to staff; a kiosk browser can request details for its own ticket. Direct anonymous table reads are revoked.
- Ticket choices are checked against the allowed grades, pathways, and tracks in the database. The database assigns queue order while locking the current session row, and browser roles have no direct ticket write permission. Staff actions use a database function that checks the staff role and permitted state transitions.
- Ticket requests are limited to 12 per source IP per minute and 120 per hour. The limiter uses the client address forwarded by Supabase's trusted edge proxy; if the proxy does not provide a usable address, the database rejects ticket requests.
- The kiosk checkboxes are still student/parent attestations. A caller can bypass the browser and claim that document review, orientation, or Brigada preparation happened; the database cannot prove those activities occurred. For stronger proof, have staff record the prerequisite check server-side or add a server-verified kiosk challenge. Keep the kiosk limited to school-managed devices or the school's network; rate limits do not establish student identity.
- The browser uses only the Supabase publishable key. Do not put a secret or service-role key in `supabase-config.js`.

## Local demo

Leave the URL and publishable key empty in `supabase-config.js` to use the browser-only demo data. Demo state persists in this browser's `localStorage`; it does not synchronize with other devices.

The local demo and new Supabase setup use placeholder destination labels Room 1–7, one per track. Replace them with the school's actual room numbers. A teacher at the destination room assigns the student's classroom; the app only routes the student to that track room.
