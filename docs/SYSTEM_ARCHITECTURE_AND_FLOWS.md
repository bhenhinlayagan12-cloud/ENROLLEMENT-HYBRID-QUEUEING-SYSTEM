# Enrollment queue — architecture and flowcharts

This document describes the current application in the repository. The matching low-fidelity screen wireframes are in [wireframes.html](./wireframes.html).

## Main workflow represented in the app

1. **Before Step 1:** a student or parent confirms that staff checked the documents and that the student watched the orientation video.
2. **Step 1:** the student receives a queue ticket, waits for the teacher meeting, then completes Brigada sign-off. Brigada is a Step 1 sub-requirement, so Step 1 is complete only after both the teacher meeting and Brigada are done.
3. **Step 2:** staff assign a room using the student's grade, pathway, and track. The database requires Brigada sign-off and serves the earliest eligible room-assignment ticket first.

## System architecture

```mermaid
flowchart LR
  subgraph Clients[Browser clients — same web app, different views]
    Kiosk[Student / parent kiosk<br/>Public, no sign-in]
    Staff[Staff dashboard<br/>Queue and service actions]
    Admin[Admin console and session setup<br/>Admin role]
    Display[Public display<br/>Current call and queue status]
  end

  subgraph Frontend[Static front end]
    Views[index.html<br/>app.js · styles.css]
    Config[supabase-config.js<br/>Project URL and publishable key]
  end

  subgraph Supabase[Supabase project]
    Auth[Supabase Auth<br/>Staff sign-in and session]
    Role[staff_roles<br/>staff / admin role]
    RPC[Database functions<br/>issue_enrollment_ticket<br/>staff_queue_action<br/>get_my_staff_role]
    DB[(Postgres tables with RLS<br/>enrollment_sessions<br/>queue_tickets<br/>queue_events<br/>track_room_mappings)]
    RT[Supabase Realtime<br/>Session, ticket, and event changes]
  end

  Kiosk --> Views
  Staff --> Views
  Admin --> Views
  Display --> Views
  Views --> Config
  Config --> RPC
  Kiosk -->|Anonymous ticket request| RPC
  Staff -->|Authenticated queue actions| Auth
  Admin -->|Authenticated admin actions| Auth
  Auth --> Role
  Auth -->|Role checked in function| RPC
  RPC <--> DB
  DB --> RT
  RT -->|Refresh live views| Views
  Display -->|Reads current session and calls| DB
```

### Component responsibilities

| Component | Responsibility |
|---|---|
| Student / parent kiosk | Collects the prerequisite confirmations, grade, pathway, and track; requests a ticket; displays the ticket and progress. |
| Staff dashboard | Calls the next ticket, starts/completes the teacher meeting, recalls or skips a called ticket, signs Brigada, and assigns rooms. |
| Admin console | Shows session health, counts, current queue, role information, and recent activity. |
| Session setup | Changes the session/station labels and pauses, resumes, or closes ticket requests. Session changes require an administrator role. |
| Public display | Shows the active teacher-station call and connection/queue status on a shared screen. |
| Supabase Auth and `staff_roles` | Authenticates staff and distinguishes staff actions from administrator-only session controls. |
| Postgres functions and RLS | Assign shared ticket order, enforce queue transitions, protect staff actions, require Brigada before room assignment, and route the room from the configured mapping. |
| Supabase Realtime | Causes the kiosk, dashboard, and display to refresh when sessions, tickets, or queue events change. |

### Data and access boundaries

- The browser uses the Supabase project URL and publishable key from `supabase-config.js`. A service-role key does not belong in this browser app.
- Students do not sign in. The kiosk can request a ticket through the public `issue_enrollment_ticket` function. The database checks that the session is active, the required fields are present, and both preparation flags are true before assigning a shared arrival number.
- Staff sign in before queue actions. `staff_queue_action` checks for a staff role; session edits and status changes also require the administrator role.
- Browser clients do not directly insert or update queue rows. Database functions perform the writes and enforce order.
- Ticket data intentionally omits student name and ID. The public kiosk currently asks users to confirm document check and orientation; it cannot independently verify that those activities actually occurred.
- The schema supports elective-aware room mappings, but the current kiosk does not collect an elective. The current interface also represents one teacher service station.
- Staff role assignment is stored in Supabase `staff_roles`; the current Admin console displays role information but does not provide a staff-account/role editor.

## Student / parent flowchart

```mermaid
flowchart TD
  Start([Open student kiosk]) --> Active{Session accepting tickets?}
  Active -- No --> Unavailable[Show paused / closed message<br/>Ticket request unavailable]
  Active -- Yes --> Prep[Confirm document check<br/>and orientation video]
  Prep --> Both{Both complete?}
  Both -- No --> Prep
  Both -- Yes --> Grade[Choose incoming grade]
  Grade --> Grade11{Grade 11?}
  Grade11 -- Yes --> Family[Choose Academic or TechPro]
  Family --> Track[Choose preferred track]
  Grade11 -- No, Grade 12 --> Previous[Choose previous track family<br/>and track]
  Track --> Review[Review grade and track]
  Previous --> Review
  Review --> Issue[Request ticket through database function]
  Issue --> Ticket[Show ticket number and progress]
  Ticket --> Wait[Wait in Step 1 area<br/>watch kiosk / public display]
  Wait --> Called{Ticket called?}
  Called -- No --> Wait
  Called -- Yes --> Teacher[Meet teacher<br/>documents checked again<br/>track and eligibility reviewed]
  Teacher --> Brigada[Complete Brigada<br/>staff signs requirement]
  Brigada --> Room[Proceed to Step 2<br/>room assignment]
  Room --> End([Room assigned; enrollment steps complete])
```

## Staff and admin flowchart

```mermaid
flowchart TD
  Open([Open staff dashboard]) --> Auth[Sign in with staff account]
  Auth --> Valid{Account has an assigned role?}
  Valid -- No --> RoleError[Show role/access message]
  Valid -- Yes --> AdminRole{Role is admin?}

  AdminRole -- Staff --> Dashboard[Open queue dashboard]
  Dashboard --> Next[Call earliest prepared waiting ticket]
  Next --> Display[Public display announces ticket]
  Display --> Service[Start teacher meeting]
  Service --> MeetingDone{Complete, recall, or skip?}
  MeetingDone -- Recall --> Display
  MeetingDone -- Skip --> Next
  MeetingDone -- Complete --> TeacherDone[Record teacher meeting complete<br/>call next ticket]
  TeacherDone --> Brigada[After cleanup, sign Brigada<br/>completes Step 1]
  Brigada --> RoomGate{Brigada signed?}
  RoomGate -- No --> Brigada
  RoomGate -- Yes --> Assign[Assign room to earliest eligible ticket<br/>using grade/pathway/track mapping]
  Assign --> Dashboard

  AdminRole -- Admin --> AdminHome[Open admin console]
  AdminHome --> Setup[Open session setup]
  Setup --> Edit[Update session name / station]
  Setup --> Status[Pause, resume, or close ticket requests]
  Status --> CloseCheck{Ticket currently called<br/>or in service?}
  CloseCheck -- Yes, closing --> Block[Finish or skip current ticket first]
  Block --> Setup
  CloseCheck -- No / not closing --> Save[Save admin action through<br/>role-checked database function]
  Edit --> Save
  Save --> Live[Realtime refreshes queue,<br/>kiosk, and public display]
  Live --> AdminHome
```

## Screen inventory

The wireframe file contains these screen groups:

- **Student / parent:** preparation, grade selection, Grade 11 track family, track selection (including Grade 12 previous-track mode), review, ticket/progress, and paused/closed session state.
- **Public display:** current call and empty-queue state.
- **Staff:** sign-in, queue dashboard, Brigada/room-assignment panel, and access-denied state.
- **Administrator:** admin console, session setup, password setup/expired-link state, and database connection state.

These are low-fidelity planning wireframes based on the current app. They are documentation only and do not change the live UI or deploy the app.
