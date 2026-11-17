# Enroll — Enrollment queue

A responsive enrollment queue app with a student ticket kiosk, staff queue dashboard, admin session controls, and public display. It can run as a local demo or use one shared Supabase database so separate devices see the same queue.

## Design documents

- [Editable Draw.io diagrams](./docs/enrollment-system-diagrams.drawio) — architecture, student flow, staff flow, and admin flow pages.
- [Low-fidelity sketch wireframes](./docs/enrollment-wireframes-figma.svg) — editable vector artwork for the Figma canvas, covering all 16 student, public display, staff, admin, and error screens.
- [Wireframe preview](./docs/wireframes.html) · [SVG generator](./docs/generate_wireframes.py)
- [Architecture notes and flow descriptions](./docs/SYSTEM_ARCHITECTURE_AND_FLOWS.md)

## Supabase connection setup

The app is configured to use the Enrollment Queue Supabase project. Authentication links return to `http://localhost:4173/?view=password` so staff can set a password before signing in. For a different Supabase project, follow these setup steps.

1. Create a dedicated Supabase project for this enrollment app.
2. In the Supabase SQL Editor, run [`supabase/schema.sql`](./supabase/schema.sql). It creates the queue tables, RLS policies, ticket-issuing and staff-action functions, and live-update publication entries.
3. Create staff accounts in Supabase Authentication. Add each staff user's Auth UUID to `public.staff_roles` in the SQL Editor. Give at least one trusted account the `admin` role:

   ```sql
   insert into public.staff_roles (user_id, role)
   values ('AUTH-USER-UUID', 'admin')
   on conflict (user_id) do update set role = excluded.role;
   ```

4. Add the school's room routing. The database mapping supports grade, pathway, track, and elective; use `*` as a fallback. The current kiosk sends grade, pathway, and track (the app does not yet ask students to choose electives). Replace the sample room label with a real room:

   ```sql
   insert into public.track_room_mappings (grade, pathway, track, elective, room_label)
   values ('*', '*', 'STEM', '*', 'Room name here');
   ```

5. Copy the Supabase Project URL and **publishable key** into [`supabase-config.js`](./supabase-config.js). Do not use a secret or service-role key in this browser app.
6. Serve this folder over HTTP (not by opening `index.html` as a file):

   ```powershell
   python -m http.server 4173
   ```

   Open `http://localhost:4173`. Use `/?view=ticket` for the kiosk, `/?view=dashboard` for staff, and `/?view=display` for the public display. Staff dashboard and admin views require a signed-in account with an assigned role. The student kiosk and public display are public.

## Queue workflow

- Document check and orientation happen before the Step 1 ticket is issued.
- Tickets receive their arrival number in the database, so issuance order is shared across kiosks.
- Step 1 consists of the teacher meeting followed by Brigada sign-off. Step 1 is complete only after both are done.
- After Brigada, room assignment is Step 2. Staff assign rooms in eligible arrival order using the configured track/grade/elective mapping.
- Supabase Realtime refreshes the kiosk, staff view, and public display when the queue changes.

The current kiosk records document and orientation completion from the kiosk flow; the public kiosk cannot independently verify that a staff member physically checked them. The staff queue actions, room assignment, and session controls are protected by Supabase authentication and database functions.

The ticket-issue function is available to the kiosk without staff sign-in. Keep the kiosk app restricted to school-managed devices or the school's network before using it for live enrollment; a public internet link would let someone request a ticket remotely. The database assigns all ticket order and prevents browser clients from calling or advancing the staff queue directly.

## Local demo

Leave the URL and publishable key empty in `supabase-config.js` to use the browser-only demo data. Demo state persists in this browser's `localStorage`; it does not synchronize with other devices.
