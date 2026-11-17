const STORAGE_KEY = "enroll-queue-demo-v1";
const VIEW_NAMES = { dashboard: "Queue dashboard", ticket: "Get a ticket", display: "Public display", admin: "Admin console", setup: "Session setup", password: "Set staff password" };
const iconNames = {
  dashboard: "ph-squares-four", ticket: "ph-ticket", display: "ph-monitor-play", admin: "ph-shield-check", setup: "ph-sliders-horizontal",
  add: "ph-plus", arrow: "ph-arrow-right", search: "ph-magnifying-glass", clock: "ph-clock", users: "ph-users-three",
  check: "ph-check-circle", trend: "ph-trend-up", bell: "ph-bell-ringing", pin: "ph-map-pin", calendar: "ph-calendar-blank",
  shield: "ph-shield-check", speaker: "ph-speaker-high", mute: "ph-speaker-slash", play: "ph-play", pause: "ph-pause",
  skip: "ph-skip-forward", refresh: "ph-arrow-counter-clockwise", expand: "ph-corners-out", menu: "ph-list", close: "ph-x",
  edit: "ph-pencil-simple", save: "ph-floppy-disk", warning: "ph-warning-circle", lock: "ph-lock-key", dots: "ph-dots-three",
  queue: "ph-list-numbers", sun: "ph-sun", sparkle: "ph-sparkle", history: "ph-clock-counter-clockwise", caret: "ph-caret-right",
  ticket: "ph-ticket", checkmark: "ph-check", bellSimple: "ph-bell-simple", info: "ph-info", broadcast: "ph-broadcast",
  graduation: "ph-graduation-cap", book: "ph-book-open", laptop: "ph-laptop", question: "ph-question", printer: "ph-printer", leftArrow: "ph-arrow-left", receipt: "ph-receipt"
};

const app = document.getElementById("app");
const dialog = document.getElementById("confirm-dialog");
const dialogConfirm = document.getElementById("dialog-confirm");
const supabaseSettings = window.ENROLL_SUPABASE_CONFIG || {};
const cloudMode = Boolean(supabaseSettings.url || supabaseSettings.publishableKey);
const supabaseClient = supabaseSettings.url && supabaseSettings.publishableKey && window.supabase?.createClient
  ? window.supabase.createClient(supabaseSettings.url, supabaseSettings.publishableKey)
  : null;
let remoteStatus = cloudMode ? "loading" : "demo";
let remoteError = "";
let remoteAuthSession = null;
let remoteStaffRole = null;
let remoteChannel = null;
let remoteRefreshTimer = null;
let remoteActionPending = false;
let activeFilter = "all";
let searchQuery = "";
let mobileMenuOpen = false;
let displaySpeechEnabled = sessionStorage.getItem("enroll-speech-enabled") === "true";
let lastSeenAnnouncement = sessionStorage.getItem("enroll-last-announcement") || "";
let pendingConfirmAction = null;
let toastTimer = null;
const academicTracks = ["STEM", "Business and Entrepreneurship", "ASSH"];
const techProTracks = ["Programming", "Visual Graphic Design", "Animation", "Bakery"];
const trackIcons = {
  STEM: "ph-flask",
  "Business and Entrepreneurship": "ph-chart-line-up",
  ASSH: "ph-palette",
  Programming: "ph-code",
  "Visual Graphic Design": "ph-pen-nib",
  Animation: "ph-film-strip",
  Bakery: "ph-cake"
};
let kioskDraft = { grade: "", pathway: "", track: "", documentsChecked: false, orientationComplete: false, step: "prerequisites" };
let kioskTrackFilter = "academic";

const now = Date.now();
const minutesAgo = (minutes) => new Date(now - minutes * 60_000).toISOString();

function seedState() {
  const tickets = [];
  for (let n = 1; n <= 18; n += 1) {
    const code = `EN-${String(((n * 7319 + 48127) % 900000) + 100000).slice(-6)}`;
    tickets.push({
      id: `seed-done-${n}`, publicCode: code, queueOrder: n, status: "COMPLETED", callCount: 1,
      progress: { documentsChecked: true, orientationComplete: true, teacherComplete: true, brigadaComplete: true, roomAssigned: true },
      createdAt: minutesAgo(115 - n * 3), calledAt: minutesAgo(112 - n * 3),
      serviceStartedAt: minutesAgo(110 - n * 3), completedAt: minutesAgo(107 - n * 3)
    });
  }
  tickets.push({
    id: "seed-current", publicCode: "EN-583104", queueOrder: 19, status: "IN_SERVICE", callCount: 1,
    progress: { documentsChecked: true, orientationComplete: true, teacherComplete: false, brigadaComplete: false, roomAssigned: false },
    createdAt: minutesAgo(14), calledAt: minutesAgo(8), serviceStartedAt: minutesAgo(4), completedAt: null
  });
  const codes = ["EN-835271", "EN-204883", "EN-619042", "EN-440615", "EN-972133", "EN-136590"];
  codes.forEach((code, index) => tickets.push({
    id: `seed-wait-${index + 1}`, publicCode: code, queueOrder: 20 + index, status: "WAITING", callCount: 0,
    progress: { documentsChecked: true, orientationComplete: true, teacherComplete: false, brigadaComplete: false, roomAssigned: false },
    createdAt: minutesAgo(5 + index * 3), calledAt: null, serviceStartedAt: null, completedAt: null
  }));
  return {
    session: { name: "Enrollment — Morning Session", status: "ACTIVE", station: "Step 1 — Teacher Station", startedAt: minutesAgo(120) },
    tickets,
    nextQueueOrder: 26,
    currentTicketId: "seed-current",
    events: [
      { id: "seed-event-3", type: "TICKET_CALLED", ticketCode: "EN-583104", createdAt: minutesAgo(8) },
      { id: "seed-event-2", type: "TICKET_COMPLETED", ticketCode: "EN-417696", createdAt: minutesAgo(14) },
      { id: "seed-event-1", type: "TICKET_CALLED", ticketCode: "EN-417696", createdAt: minutesAgo(20) }
    ]
  };
}

function loadState() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed?.session && Array.isArray(parsed.tickets) && Array.isArray(parsed.events)) {
        parsed.tickets.forEach(ensureTicketProgress);
        return parsed;
      }
    }
  } catch (error) { console.warn("Could not read the saved demo queue.", error); }
  return seedState();
}

function ensureTicketProgress(ticket) {
  const saved = ticket.progress && typeof ticket.progress === "object" ? ticket.progress : {};
  const wasServed = ticket.status === "COMPLETED";
  ticket.progress = {
    documentsChecked: saved.documentsChecked ?? true,
    orientationComplete: saved.orientationComplete ?? true,
    teacherComplete: saved.teacherComplete ?? wasServed,
    brigadaComplete: saved.brigadaComplete ?? wasServed,
    roomAssigned: saved.roomAssigned ?? wasServed,
    teacherCompletedAt: saved.teacherCompletedAt || (wasServed ? ticket.completedAt || ticket.createdAt : null),
    brigadaCompletedAt: saved.brigadaCompletedAt || (wasServed ? ticket.completedAt || ticket.createdAt : null)
  };
}

let state = loadState();
if (!cloudMode && !localStorage.getItem(STORAGE_KEY)) persistState(false);

function persistState(shouldRender = true) {
  if (!cloudMode) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch (error) { console.warn("Could not save the demo queue.", error); }
  }
  if (shouldRender) render();
}

function backendErrorMessage(error) {
  const message = String(error?.message || error || "Could not connect to Supabase.");
  if (/Failed to fetch|NetworkError|Load failed/i.test(message)) return "Could not reach Supabase. Check the project URL, publishable key, and internet connection.";
  if (/staff sign-in|required|permission denied|row-level security|42501/i.test(message)) return "Staff sign-in is required for this action, or this account has not been given a staff role.";
  return message;
}

async function loadRemoteState() {
  if (!supabaseClient) throw new Error("The Supabase client did not load. Check your internet connection and reload this page.");
  const [sessionResult, ticketsResult, eventsResult] = await Promise.all([
    supabaseClient.from("enrollment_sessions").select("id,name,station,status,started_at").eq("is_current", true).maybeSingle(),
    supabaseClient.from("queue_tickets").select("id,session_id,public_code,queue_order,status,grade,pathway,track,elective,progress,room_label,call_count,created_at,called_at,service_started_at,completed_at,skipped_at").order("queue_order", { ascending: true }),
    supabaseClient.from("queue_events").select("id,session_id,event_type,ticket_code,created_at").order("created_at", { ascending: false }).limit(100)
  ]);
  if (sessionResult.error) throw sessionResult.error;
  if (ticketsResult.error) throw ticketsResult.error;
  if (eventsResult.error) throw eventsResult.error;
  const session = sessionResult.data;
  if (!session) throw new Error("No current enrollment session was found. Run the Supabase schema setup first.");
  const tickets = (ticketsResult.data || []).filter((ticket) => ticket.session_id === session.id).map((ticket) => ({
    id: ticket.id,
    publicCode: ticket.public_code,
    queueOrder: ticket.queue_order,
    status: ticket.status,
    grade: ticket.grade,
    pathway: ticket.pathway,
    track: ticket.track,
    elective: ticket.elective,
    progress: ticket.progress || {},
    roomLabel: ticket.room_label,
    callCount: ticket.call_count || 0,
    createdAt: ticket.created_at,
    calledAt: ticket.called_at,
    serviceStartedAt: ticket.service_started_at,
    completedAt: ticket.completed_at,
    skippedAt: ticket.skipped_at
  }));
  tickets.forEach(ensureTicketProgress);
  state = {
    session: { id: session.id, name: session.name, station: session.station, status: session.status, startedAt: session.started_at },
    tickets,
    events: (eventsResult.data || []).filter((event) => event.session_id === session.id).map((event) => ({
      id: event.id, type: event.event_type, ticketCode: event.ticket_code, createdAt: event.created_at
    })),
    nextQueueOrder: tickets.reduce((max, ticket) => Math.max(max, ticket.queueOrder), 0) + 1,
    currentTicketId: tickets.find((ticket) => ["CALLED", "IN_SERVICE"].includes(ticket.status))?.id || null
  };
  return state;
}

async function refreshRemoteState(shouldRender = true) {
  try {
    await loadRemoteState();
    remoteStatus = "ready";
    remoteError = "";
    if (shouldRender) render();
  } catch (error) {
    remoteStatus = "error";
    remoteError = backendErrorMessage(error);
    if (shouldRender) render();
    throw error;
  }
}

async function refreshStaffRole() {
  remoteStaffRole = null;
  if (!remoteAuthSession || !supabaseClient) return;
  const { data, error } = await supabaseClient.rpc("get_my_staff_role");
  if (error) throw error;
  remoteStaffRole = data || null;
}

function subscribeToRemoteChanges() {
  if (!supabaseClient || remoteChannel) return;
  remoteChannel = supabaseClient.channel("enrollment-queue-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "enrollment_sessions" }, scheduleRemoteRefresh)
    .on("postgres_changes", { event: "*", schema: "public", table: "queue_tickets" }, scheduleRemoteRefresh)
    .on("postgres_changes", { event: "*", schema: "public", table: "queue_events" }, scheduleRemoteRefresh)
    .subscribe();
}

function scheduleRemoteRefresh() {
  clearTimeout(remoteRefreshTimer);
  remoteRefreshTimer = setTimeout(() => { refreshRemoteState().catch(() => {}); }, 120);
}

async function initializeBackend() {
  if (!cloudMode) { render(); return; }
  if (!supabaseClient) {
    remoteStatus = "error";
    remoteError = !(supabaseSettings.url && supabaseSettings.publishableKey)
      ? "Enter both the Supabase project URL and publishable key in supabase-config.js."
      : "The Supabase client could not load. Check your internet connection and reload.";
    render();
    return;
  }
  try {
    const { data, error } = await supabaseClient.auth.getSession();
    if (error) throw error;
    remoteAuthSession = data.session;
    await loadRemoteState();
    if (remoteAuthSession) await refreshStaffRole();
    remoteStatus = "ready";
    subscribeToRemoteChanges();
    supabaseClient.auth.onAuthStateChange((_event, session) => {
      remoteAuthSession = session;
      remoteStaffRole = null;
      if (!session) { render(); return; }
      setTimeout(async () => {
        try { await refreshStaffRole(); }
        catch (error) { remoteError = backendErrorMessage(error); }
        render();
      }, 0);
    });
  } catch (error) {
    remoteStatus = "error";
    remoteError = backendErrorMessage(error);
  }
  render();
}

async function runRemoteAction(action, ticketId = null, payload = {}) {
  if (remoteActionPending) return false;
  remoteActionPending = true;
  try {
    const { error } = await supabaseClient.rpc("staff_queue_action", {
      p_action: action,
      p_ticket_id: ticketId || null,
      p_payload: payload
    });
    if (error) throw error;
    await refreshRemoteState(false);
    render();
    return true;
  } catch (error) {
    showToast(backendErrorMessage(error), "error");
    return false;
  } finally {
    remoteActionPending = false;
  }
}

async function runRemoteTicketIssue(selection) {
  try {
    const { data, error } = await supabaseClient.rpc("issue_enrollment_ticket", {
      p_grade: `Grade ${selection.grade}`,
      p_pathway: selection.pathway === "academic" ? "Academic track" : "TechPro",
      p_track: selection.track,
      p_documents_checked: Boolean(selection.documentsChecked),
      p_orientation_complete: Boolean(selection.orientationComplete),
      p_elective: selection.elective || null
    });
    if (error) throw error;
    sessionStorage.setItem("enroll-my-ticket", data.id);
    await refreshRemoteState(false);
    render();
    showToast(`${data.public_code} is now in the queue.`);
  } catch (error) {
    showToast(backendErrorMessage(error), "error");
  }
}

function connectionView() {
  return `<main class="cloud-gate"><section class="view-card cloud-gate-card"><span class="cloud-gate-icon">${icon("broadcast")}</span><p class="eyebrow">Shared enrollment queue</p><h1>${remoteStatus === "loading" ? "Connecting to the queue" : "Database connection needs attention"}</h1><p>${esc(remoteStatus === "loading" ? "Loading the current session and tickets from Supabase…" : remoteError)}</p>${remoteStatus === "error" ? `<button class="button button-primary" data-action="retry-cloud">${icon("refresh")}Try again</button>` : ""}</section></main>`;
}

function staffAuthView() {
  const signedInWithoutRole = Boolean(remoteAuthSession && !remoteStaffRole);
  const adminOnly = remoteStaffRole === "staff";
  const restricted = signedInWithoutRole || adminOnly;
  const title = signedInWithoutRole ? "Staff access is not assigned" : adminOnly ? "Administrator access is required" : "Sign in to manage the queue";
  const copy = signedInWithoutRole ? "This account is signed in, but it has no staff role in the enrollment database. Ask an administrator to add it." : adminOnly ? "Your staff account can work the queue, but only an administrator can manage session settings." : "Use your school staff account. The student kiosk and public display do not require staff sign-in.";
  return `<main class="cloud-gate"><section class="view-card cloud-gate-card"><span class="cloud-gate-icon">${icon("lock")}</span><p class="eyebrow">Staff access</p><h1>${title}</h1><p>${copy}</p>${restricted ? `<button class="button button-secondary" data-action="staff-sign-out">Sign out</button>` : `<form class="cloud-login-form" id="staff-login-form"><label for="staff-email">Staff email</label><input id="staff-email" name="email" type="email" autocomplete="username" required /><label for="staff-password">Password</label><input id="staff-password" name="password" type="password" autocomplete="current-password" required /><p class="cloud-login-error" id="cloud-login-error" role="alert"></p><button class="button button-primary" type="submit">${icon("lock")}Sign in</button><button class="button button-quiet" type="button" data-action="send-password-link">Send password setup link</button></form>`}</section></main>`;
}

function passwordSetupView() {
  const content = remoteAuthSession
    ? `<span class="cloud-gate-icon">${icon("lock")}</span><p class="eyebrow">Staff account</p><h1>Set your password</h1><p>Create a password for ${esc(remoteAuthSession.user?.email || "your staff account")} to use when signing in.</p><form class="cloud-login-form" id="password-setup-form"><label for="new-staff-password">New password</label><input id="new-staff-password" name="password" type="password" autocomplete="new-password" minlength="8" required /><label for="confirm-staff-password">Confirm password</label><input id="confirm-staff-password" name="confirmation" type="password" autocomplete="new-password" minlength="8" required /><p class="cloud-login-error" id="password-setup-error" role="alert"></p><button class="button button-primary" type="submit">Save password</button></form>`
    : `<span class="cloud-gate-icon">${icon("warning")}</span><p class="eyebrow">Staff account</p><h1>This link is expired or already used</h1><p>Return to staff sign-in and request a fresh password setup link.</p><button class="button button-primary" data-action="password-back">${icon("leftArrow")}Go to staff sign-in</button>`;
  return `<main class="cloud-gate"><section class="view-card cloud-gate-card">${content}</section></main>`;
}

function bindCloudGateEvents() {
  const form = document.getElementById("staff-login-form");
  if (form) form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = form.querySelector("button[type='submit']");
    const errorNode = document.getElementById("cloud-login-error");
    submit.disabled = true;
    errorNode.textContent = "";
    const values = new FormData(form);
    try {
      const { data, error } = await supabaseClient.auth.signInWithPassword({ email: String(values.get("email") || "").trim(), password: String(values.get("password") || "") });
      if (error) throw error;
      remoteAuthSession = data.session;
      await refreshStaffRole();
      render();
    } catch (error) {
      errorNode.textContent = backendErrorMessage(error);
      submit.disabled = false;
    }
  });
  const passwordLinkButton = app.querySelector('[data-action="send-password-link"]');
  if (passwordLinkButton) passwordLinkButton.addEventListener("click", async () => {
    const email = form?.elements.email?.value.trim();
    const errorNode = document.getElementById("cloud-login-error");
    if (!email) { errorNode.textContent = "Enter your staff email first."; return; }
    passwordLinkButton.disabled = true;
    errorNode.textContent = "";
    try {
      const redirectTo = new URL(location.href);
      redirectTo.searchParams.set("view", "password");
      redirectTo.hash = "";
      const { error } = await supabaseClient.auth.resetPasswordForEmail(email, { redirectTo: redirectTo.toString() });
      if (error) throw error;
      showToast("If that staff account exists, a password setup link has been sent.");
    } catch (error) {
      errorNode.textContent = backendErrorMessage(error);
      passwordLinkButton.disabled = false;
    }
  });
  app.querySelectorAll('[data-action="staff-sign-out"]').forEach((button) => button.addEventListener("click", signOutStaff));
  app.querySelectorAll('[data-action="retry-cloud"]').forEach((button) => button.addEventListener("click", () => {
    remoteStatus = "loading";
    render();
    initializeBackend();
  }));
}

function bindPasswordSetupEvents() {
  app.querySelectorAll('[data-action="password-back"]').forEach((button) => button.addEventListener("click", () => goToView("dashboard")));
  const form = document.getElementById("password-setup-form");
  if (!form) return;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = form.querySelector("button[type='submit']");
    const errorNode = document.getElementById("password-setup-error");
    const values = new FormData(form);
    const password = String(values.get("password") || "");
    const confirmation = String(values.get("confirmation") || "");
    if (password !== confirmation) { errorNode.textContent = "The passwords do not match."; return; }
    submit.disabled = true;
    errorNode.textContent = "";
    try {
      const { error } = await supabaseClient.auth.updateUser({ password });
      if (error) throw error;
      const { data, error: sessionError } = await supabaseClient.auth.getSession();
      if (sessionError) throw sessionError;
      remoteAuthSession = data.session;
      await refreshStaffRole();
      const url = new URL(location.href);
      url.searchParams.delete("view");
      url.hash = "";
      history.replaceState({}, "", `${url.pathname}${url.search}`);
      render();
      showToast("Password saved. You are signed in.");
    } catch (error) {
      errorNode.textContent = backendErrorMessage(error);
      submit.disabled = false;
    }
  });
}

async function signOutStaff() {
  if (!supabaseClient) return;
  await supabaseClient.auth.signOut();
  remoteAuthSession = null;
  remoteStaffRole = null;
  render();
}

function icon(name, extra = "") {
  return `<i class="ph ${iconNames[name] || name}" aria-hidden="true" ${extra}></i>`;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function currentView() {
  const requested = new URLSearchParams(location.search).get("view");
  return Object.hasOwn(VIEW_NAMES, requested) ? requested : "dashboard";
}

function goToView(view) {
  const url = new URL(location.href);
  if (view === "dashboard") url.searchParams.delete("view");
  else url.searchParams.set("view", view);
  history.pushState({}, "", `${url.pathname}${url.search}${url.hash}`);
  mobileMenuOpen = false;
  render();
}

function dateLabel() {
  return new Intl.DateTimeFormat("en-SG", { weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(new Date());
}

function timeLabel(iso) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-SG", { hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

function relativeTime(iso) {
  if (!iso) return "Just now";
  const mins = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m ago`;
}

function waitingTickets() {
  return state.tickets.filter((ticket) => ticket.status === "WAITING").sort((a, b) => a.queueOrder - b.queueOrder);
}

function teacherReadyTickets() {
  return waitingTickets().filter((ticket) => ticket.progress?.documentsChecked && ticket.progress?.orientationComplete);
}

function processStage(ticket) {
  const progress = ticket.progress || {};
  if (!progress.documentsChecked) return "documents";
  if (!progress.orientationComplete) return "orientation";
  if (!progress.teacherComplete) return "teacher";
  if (!progress.brigadaComplete) return "brigada";
  if (!progress.roomAssigned) return "room";
  return "done";
}

function processStageLabel(ticket) {
  const stage = processStage(ticket);
  if (stage === "documents") return "Document check needed";
  if (stage === "orientation") return "Orientation needed";
  if (stage === "teacher") return ticket.status === "IN_SERVICE" ? "Teacher meeting" : ticket.status === "CALLED" ? "Proceed to teacher" : "Waiting for teacher";
  if (stage === "brigada") return "Step 1 sub-requirement · Brigada";
  if (stage === "room") return "Ready for Step 2 · Room assignment";
  return "Enrollment complete";
}

function stageQueue(stage) {
  const arrivedAtStage = (ticket) => stage === "brigada"
    ? ticket.progress?.teacherCompletedAt || ticket.createdAt
    : stage === "room" ? ticket.progress?.brigadaCompletedAt || ticket.createdAt : ticket.createdAt;
  return state.tickets.filter((ticket) => !["SKIPPED", "CANCELLED"].includes(ticket.status) && processStage(ticket) === stage)
    .sort((a, b) => new Date(arrivedAtStage(a)).getTime() - new Date(arrivedAtStage(b)).getTime() || a.queueOrder - b.queueOrder);
}

function isFirstAtStage(ticket, stage) {
  return stageQueue(stage)[0]?.id === ticket.id;
}

function currentTicket() {
  return state.tickets.find((ticket) => ticket.id === state.currentTicketId) || null;
}

function statusClass(status) {
  return status === "IN_SERVICE" ? "in-service" : status === "WAITING" ? "waiting" : status === "CALLED" ? "called" : "";
}

function statusLabel(status) {
  return ({ WAITING: "Waiting", CALLED: "Called", IN_SERVICE: "In service", COMPLETED: "Completed", SKIPPED: "No-show", CANCELLED: "Cancelled" })[status] || status;
}

function sessionStatusLabel() {
  return state.session.status === "ACTIVE" ? "Session active" : state.session.status === "PAUSED" ? "Session paused" : "Session closed";
}

function activeSessionClass() {
  return state.session.status === "ACTIVE" ? "" : state.session.status.toLowerCase();
}

function getMetricEstimate() {
  return Math.max(0, waitingTickets().length * 4);
}

function announcementEvent() {
  return state.events.find((event) => event.type === "TICKET_CALLED" || event.type === "TICKET_RECALLED") || null;
}

function navButton(view, label, isActive) {
  return `<button class="nav-link ${isActive ? "active" : ""}" data-nav="${view}" ${isActive ? 'aria-current="page"' : ""}>${icon(view)}<span>${label}</span></button>`;
}

function shell(content, activeView) {
  const title = VIEW_NAMES[activeView];
  return `<div class="app-shell">
    <button class="sidebar-scrim ${mobileMenuOpen ? "visible" : ""}" data-action="close-menu" aria-label="Close navigation"></button>
    <aside class="sidebar ${mobileMenuOpen ? "open" : ""}" aria-label="Main navigation">
      <div class="brand"><span class="brand-mark">${icon("sparkle")}</span><span>enroll<small>Queue management</small></span></div>
      <div class="nav-label">Workspace</div>
      <nav class="sidebar-nav">
        ${navButton("dashboard", "Queue dashboard", activeView === "dashboard")}
        ${navButton("ticket", "Get a ticket", activeView === "ticket")}
        ${navButton("display", "Public display", activeView === "display")}
      </nav>
      <div class="nav-label" style="margin-top:27px">Manage</div>
      <nav class="sidebar-nav">${navButton("admin", "Admin console", activeView === "admin")}${navButton("setup", "Session setup", activeView === "setup")}</nav>
      <div class="sidebar-spacer"></div>
      <div class="sidebar-session">
        <div class="mini-label">Current session</div>
        <strong>${esc(state.session.name)}</strong>
        <span class="session-indicator ${activeSessionClass()}">${sessionStatusLabel()}</span>
      </div>
      <div class="profile"><div class="avatar">${cloudMode ? "ST" : "JD"}</div><div><div class="profile-name">${cloudMode ? "Signed-in staff" : "Jordan Davis"}</div><div class="profile-role">${cloudMode ? esc(remoteStaffRole || "Staff") : activeView === "admin" || activeView === "setup" ? "Administrator · Preview" : "Enrollment staff"}</div></div><i class="ph ph-dots-three profile-dots" aria-hidden="true"></i></div>
    </aside>
    <section class="main-column">
      <header class="topbar">
        <div class="topbar-left"><button class="mobile-menu" data-action="open-menu" aria-label="Open navigation">${icon("menu")}</button><span class="topbar-context"><strong>${esc(title)}</strong></span><span class="vertical-divider"></span><span class="top-date">${dateLabel()}</span></div>
        <div class="topbar-actions"><span class="demo-pill">${icon(cloudMode ? "broadcast" : "info")}${cloudMode ? "Supabase connected" : "Local demo"}</span><button class="button button-secondary" data-action="open-display">${icon("display")}<span>Public display</span></button>${cloudMode ? `<button class="subtle-button" data-action="staff-sign-out">Sign out</button>` : ""}</div>
      </header>
      <main class="page-wrap">${content}</main>
    </section>
  </div>`;
}

function currentTicketCard() {
  const ticket = currentTicket();
  if (!ticket) return `<section class="current-card" aria-label="Current ticket"><div class="current-topline"><span>Step 1 · Teacher meeting</span><span class="step-chip">${icon("pin")} ${esc(state.session.station)}</span></div><div class="current-empty"><div><h3>Teacher station is ready</h3><p>Call the next prepared student when you’re ready.</p></div><div class="empty-symbol">${icon("queue")}</div></div><div class="current-actions"><button class="button button-primary" data-action="call-next" ${waitingTickets().length === 0 ? "disabled" : ""}>${icon("bell")}Call next Step 1 ticket</button></div></section>`;
  const isServing = ticket.status === "IN_SERVICE";
  return `<section class="current-card" aria-label="Current ticket"><div class="current-topline"><span>Now serving</span><span class="step-chip">${icon("pin")} ${esc(state.session.station)}</span></div><div class="current-main"><div><span class="current-code-label">Ticket number</span><span class="current-code">${esc(ticket.publicCode)}</span><div class="current-detail">Called at ${timeLabel(ticket.calledAt)} · ${ticket.callCount} ${ticket.callCount === 1 ? "call" : "calls"}</div></div><span class="status-chip ${statusClass(ticket.status)}">${statusLabel(ticket.status)}</span></div><div class="current-actions">
    <button class="button button-primary" data-action="complete-next" ${!isServing ? "disabled" : ""}>${icon("check")}Complete teacher meeting &amp; call next</button>
    <button class="button button-secondary" data-action="start-service" ${isServing ? "disabled" : ""}>${icon("play")}${isServing ? "Meeting in progress" : "Start teacher meeting"}</button>
    <button class="button button-quiet" data-action="recall">${icon("refresh")}Recall</button>
    <button class="button button-quiet" data-action="confirm-skip" ${isServing ? "disabled" : ""}>${icon("skip")}Skip</button>
  </div><div class="current-process"><span class="process-check done">${icon("checkmark")}Documents checked</span><span class="process-check done">${icon("checkmark")}Orientation complete</span><span class="process-current">Step 1 · Teacher meeting</span></div>${!isServing ? '<div class="current-detail">After the meeting, Brigada sign-off completes Step 1.</div>' : ""}</section>`;
}

function queueRowsHtml() {
  const eligible = state.tickets.filter((ticket) => activeFilter === "waiting"
    ? ticket.status === "WAITING"
    : ["WAITING", "CALLED", "IN_SERVICE"].includes(ticket.status));
  const visible = eligible.sort((a, b) => a.queueOrder - b.queueOrder).filter((ticket) => ticket.publicCode.toLowerCase().includes(searchQuery.toLowerCase()));
  if (!visible.length) return `<tr class="queue-empty-row"><td colspan="5">${searchQuery ? "No tickets match your search." : "No one is waiting. You’re all caught up."}</td></tr>`;
  return visible.map((ticket) => `<tr>
    <td><span class="queue-order">#${String(ticket.queueOrder).padStart(3, "0")}</span></td>
    <td><span class="queue-code">${esc(ticket.publicCode)}</span>${ticket.grade || ticket.track ? `<span class="queue-meta">${esc(ticket.grade || "")} · ${esc(ticket.track || "")}</span>` : ""}</td>
    <td><span class="wait-time">${relativeTime(ticket.createdAt)}</span></td>
    <td><span class="process-chip ${processStage(ticket)}">${esc(processStageLabel(ticket))}</span></td>
    <td><span class="status-chip ${statusClass(ticket.status)}">${statusLabel(ticket.status)}</span></td>
  </tr>`).join("");
}

function queuePanel() {
  const waiting = waitingTickets();
  const inQueueCount = state.tickets.filter((ticket) => ["WAITING", "CALLED", "IN_SERVICE"].includes(ticket.status)).length;
  const nextReady = teacherReadyTickets()[0];
  return `<section class="panel queue-panel"><div class="panel-head"><div><h2 class="panel-title">Step 1 · Teacher queue <span style="color:#9aa29a;font-weight:500">(${inQueueCount})</span></h2><p class="panel-subtitle">Tickets are issued after document check and orientation</p></div><button class="panel-link" data-action="go-ticket">Issue ticket ${icon("arrow")}</button></div>
    <div class="queue-tools"><label class="search-box">${icon("search")}<input id="queue-search" type="search" value="${esc(searchQuery)}" placeholder="Search ticket number" aria-label="Search ticket number" /></label><div class="filter-tabs" role="group" aria-label="Filter queue"><button class="filter-tab ${activeFilter === "all" ? "active" : ""}" data-filter="all">All tickets</button><button class="filter-tab ${activeFilter === "waiting" ? "active" : ""}" data-filter="waiting">Waiting</button></div></div>
    <table class="queue-table"><thead><tr><th>Order</th><th>Ticket</th><th>Waiting</th><th>Current step</th><th>Status</th></tr></thead><tbody id="queue-list">${queueRowsHtml()}</tbody></table><div class="queue-foot"><span>Sorted by <strong>arrival order</strong></span><span>${nextReady ? `Next up · <strong>${esc(nextReady.publicCode)}</strong>` : waiting.length ? "Waiting on Step 1 readiness" : "Queue is clear"}</span></div></section>`;
}

function afterTeacherPanel() {
  const nextRoom = stageQueue("room")[0];
  const tickets = [...stageQueue("brigada"), ...stageQueue("room")];
  const rows = tickets.map((ticket) => {
    const stage = processStage(ticket);
    const canAdvance = stage === "brigada" || nextRoom?.id === ticket.id;
    const action = stage === "brigada" ? "complete-brigada" : "assign-room";
    const label = stage === "brigada" ? "Sign Brigada" : "Assign room";
    return `<div class="after-step-row"><div class="after-step-ticket"><span class="queue-order">#${String(ticket.queueOrder).padStart(3, "0")}</span><strong>${esc(ticket.publicCode)}</strong><small>${esc(processStageLabel(ticket))}</small></div><button class="button ${canAdvance ? "button-secondary" : "button-quiet"}" data-action="${action}" data-ticket-id="${esc(ticket.id)}" ${canAdvance ? "" : "disabled"}>${canAdvance ? label : "Wait turn"}</button></div>`;
  }).join("");
  return `<section class="panel after-step-panel"><div class="panel-head"><div><h2 class="panel-title">Step 1 completion &amp; Step 2 room assignment</h2><p class="panel-subtitle">Brigada sign-off completes Step 1; room assignment follows</p></div><span class="step-chip">Steps 1 &amp; 2</span></div><div class="after-step-list">${rows || '<div class="activity-empty">No students are waiting for Brigada or room assignment.</div>'}</div><div class="after-step-foot">${icon("info")} Sign Brigada to complete Step 1; assign rooms in eligible arrival order.</div></section>`;
}

function sessionCard() {
  const next = teacherReadyTickets()[0];
  const current = currentTicket();
  return `<section class="panel side-card"><div class="side-card-head"><h2>Session overview</h2><span>${icon("calendar")} ${dateLabel()}</span></div><div class="session-details">
    <div class="detail-row"><span class="detail-icon">${icon("ticket")}</span><div class="detail-copy"><small>Session</small><strong>${esc(state.session.name)}</strong></div></div>
    <div class="detail-row"><span class="detail-icon">${icon("pin")}</span><div class="detail-copy"><small>Service station</small><strong>${esc(state.session.station)}</strong></div></div>
    <div class="detail-row"><span class="detail-icon">${icon("bellSimple")}</span><div class="detail-copy"><small>Up next</small><strong>${next ? esc(next.publicCode) : "No tickets waiting"}</strong></div></div>
    <div class="detail-row"><span class="detail-icon">${icon("users")}</span><div class="detail-copy"><small>At station</small><strong>${current ? `${esc(current.publicCode)} · ${statusLabel(current.status)}` : "Station available"}</strong></div></div>
  </div><div class="session-action-row"><span class="small-status ${activeSessionClass()}">${state.session.status}</span><button class="subtle-button" data-nav="setup">Manage session ${icon("arrow")}</button></div></section>`;
}

function activityLine(event) {
  const labels = { TICKET_CALLED: "called to the teacher", TICKET_COMPLETED: "completed service", TEACHER_MEETING_COMPLETED: "completed the teacher meeting", BRIGADA_COMPLETED: "completed Brigada", ROOM_ASSIGNED: "received a room assignment", TICKET_SKIPPED: "marked as no-show", TICKET_RECALLED: "recalled to the station", TICKET_CREATED: "joined the Step 1 queue", SERVICE_STARTED: "service started" };
  const glyph = ["TICKET_COMPLETED", "TEACHER_MEETING_COMPLETED", "BRIGADA_COMPLETED", "ROOM_ASSIGNED"].includes(event.type) ? "check" : event.type === "TICKET_CREATED" ? "add" : event.type === "TICKET_SKIPPED" ? "skip" : "bell";
  return `<div class="activity-item"><span class="activity-dot">${icon(glyph)}</span><div class="activity-copy"><strong>${esc(event.ticketCode || "Session")} ${labels[event.type] || "updated"}</strong><span>${timeLabel(event.createdAt)}</span></div><span class="activity-time">${relativeTime(event.createdAt)}</span></div>`;
}

function activityPanel() {
  const latest = state.events.slice(0, 4);
  return `<section class="panel side-card"><div class="side-card-head"><h2>Recent activity</h2><span>Today ${icon("history")}</span></div><div class="activity-list">${latest.length ? latest.map(activityLine).join("") : '<div class="activity-empty">Queue activity will appear here.</div>'}</div><div class="session-action-row"><span style="font-size:9px;color:#96a098">Latest queue events</span><button class="subtle-button" data-action="view-history">View all ${icon("arrow")}</button></div></section>`;
}

function dashboardView() {
  const waiting = teacherReadyTickets().length;
  const completed = state.tickets.filter((ticket) => ticket.status === "COMPLETED").length;
  const sessionStatusCopy = state.session.status === "ACTIVE" ? "Students can join the queue" : state.session.status === "PAUSED" ? "Ticket requests are paused" : "Ticket requests are closed";
  const content = `<div class="page-heading"><div><p class="eyebrow">Good morning, Jordan</p><h1>Enrollment queue</h1><p class="page-subtitle">Step 1 includes the teacher meeting and Brigada. Document check and orientation come before ticket issue; Step 2 is room assignment.</p></div><div class="heading-actions"><span class="session-indicator ${activeSessionClass()}">${sessionStatusLabel()}</span><button class="button button-primary" data-action="go-ticket">${icon("add")}Get a ticket</button></div></div>
    <div class="metrics">
      <article class="metric-card"><div class="metric-top"><span>Waiting for teacher</span><span class="metric-icon">${icon("users")}</span></div><strong class="metric-value">${waiting}</strong><span class="metric-caption">${waiting ? `First up · ${esc(teacherReadyTickets()[0].publicCode)}` : "No students in line"}</span></article>
      <article class="metric-card"><div class="metric-top"><span>Served today</span><span class="metric-icon">${icon("check")}</span></div><strong class="metric-value">${completed}</strong><span class="metric-caption"><span class="metric-up">${icon("trend")} Steady progress</span></span></article>
      <article class="metric-card"><div class="metric-top"><span>Estimated wait</span><span class="metric-icon">${icon("clock")}</span></div><strong class="metric-value">${getMetricEstimate()}<span style="font-size:13px;font-weight:600;letter-spacing:0"> min</span></strong><span class="metric-caption">Based on today’s service pace</span></article>
      <article class="metric-card"><div class="metric-top"><span>Session status</span><span class="metric-icon">${icon("broadcast")}</span></div><strong class="metric-value" style="font-size:20px;letter-spacing:-.04em">${state.session.status === "ACTIVE" ? "Open" : state.session.status === "PAUSED" ? "Paused" : "Closed"}</strong><span class="metric-caption">${sessionStatusCopy}</span></article>
    </div>
    <div class="dashboard-grid"><div class="left-stack">${currentTicketCard()}${queuePanel()}${afterTeacherPanel()}</div><div class="right-stack">${sessionCard()}${activityPanel()}<div class="privacy-note">${icon("shield")}<span><strong>Privacy first.</strong> Tickets use a random code. No student names or personal details are collected.</span></div></div></div>`;
  return shell(content, "dashboard");
}

function getMyTicket() {
  const ownId = sessionStorage.getItem("enroll-my-ticket");
  return ownId ? state.tickets.find((ticket) => ticket.id === ownId) || null : null;
}

function trackPathway(track) {
  return academicTracks.includes(track) ? "Academic track" : "TechPro";
}

function kioskTrackCards() {
  const tracks = kioskDraft.grade === "11"
    ? kioskDraft.pathway === "academic" ? academicTracks : techProTracks
    : kioskTrackFilter === "academic" ? academicTracks : techProTracks;
  return tracks.map((track) => {
    const selected = kioskDraft.track === track;
    const trackIcon = trackIcons[track] || "ph-sparkle";
    const detail = kioskDraft.grade === "11" && track === "STEM"
      ? "Minimum 90 in every Grade 10 subject"
      : track === "ASSH" ? "Arts, Social Sciences & Humanities"
      : kioskDraft.grade === "11" ? `Grade 11 · ${trackPathway(track)}` : `Previously enrolled · ${trackPathway(track)}`;
    return `<button class="kiosk-choice-card kiosk-track-card ${selected ? "selected" : ""}" data-kiosk-action="select-track" data-value="${esc(track)}" aria-pressed="${selected}"><span class="kiosk-choice-icon">${icon(trackIcon)}</span><span class="kiosk-choice-copy"><strong>${esc(track)}</strong><small>${detail}</small></span><span class="kiosk-choice-check">${icon("checkmark")}</span></button>`;
  }).join("");
}

function prerequisiteChoice(value, title, detail, complete) {
  return `<button class="kiosk-choice-card kiosk-prereq-card ${complete ? "selected" : ""}" data-kiosk-action="toggle-prerequisite" data-value="${value}" aria-pressed="${complete}"><span class="kiosk-choice-icon">${icon(complete ? "checkmark" : "clock")}</span><span class="kiosk-choice-copy"><strong>${title}</strong><small>${detail}</small></span><span class="kiosk-choice-check">${icon("checkmark")}</span></button>`;
}

function kioskStepContent() {
  if (kioskDraft.step === "prerequisites") return `<div class="kiosk-step-content" key="prerequisites">
    <div class="kiosk-section-kicker">PREPARATION · BEFORE STEP 1</div><h1>Ready for the teacher queue?</h1><p class="kiosk-lede">Complete both preparation requirements before requesting a Step 1 ticket.</p>
    <div class="kiosk-choice-grid kiosk-prereq-grid" role="group" aria-label="Confirm preparation requirements">
      ${prerequisiteChoice("documentsChecked", "Document check complete", "Have staff checked your enrollment documents?", kioskDraft.documentsChecked)}
      ${prerequisiteChoice("orientationComplete", "Orientation complete", "Have you watched the orientation video?", kioskDraft.orientationComplete)}
    </div><div class="kiosk-note">${icon("info")} Only confirm documents after staff checks them, and orientation after you watch the video. Discuss your preferred track and eligibility at Step 1.</div>
  </div>`;

  if (kioskDraft.step === "grade") return `<div class="kiosk-step-content" key="grade">
    <div class="kiosk-section-kicker">TICKET FORM · STEP 2 OF ${kioskDraft.grade === "11" ? "5" : "4"}</div><h1>Who is enrolling today?</h1><p class="kiosk-lede">Choose the student's incoming grade level to get started.</p>
    <div class="kiosk-choice-grid kiosk-grade-grid" role="group" aria-label="Choose incoming grade level">
      <button class="kiosk-choice-card kiosk-grade-card ${kioskDraft.grade === "11" ? "selected" : ""}" data-kiosk-action="select-grade" data-value="11" aria-pressed="${kioskDraft.grade === "11"}"><span class="kiosk-choice-icon">${icon("users")}</span><span class="kiosk-choice-copy"><strong>Incoming Grade 11</strong><small>Choose your preferred track</small></span><span class="kiosk-choice-check">${icon("checkmark")}</span></button>
      <button class="kiosk-choice-card kiosk-grade-card ${kioskDraft.grade === "12" ? "selected" : ""}" data-kiosk-action="select-grade" data-value="12" aria-pressed="${kioskDraft.grade === "12"}"><span class="kiosk-choice-icon">${icon("graduation")}</span><span class="kiosk-choice-copy"><strong>Incoming Grade 12</strong><small>Tell us the track you were in before</small></span><span class="kiosk-choice-check">${icon("checkmark")}</span></button>
    </div><div class="kiosk-note">${icon("info")} A parent or guardian can complete this step with the student.</div>
  </div>`;

  if (kioskDraft.step === "pathway") return `<div class="kiosk-step-content" key="pathway">
    <div class="kiosk-section-kicker">TICKET FORM · STEP 3 OF 5 · INCOMING GRADE 11</div><h1>Choose a track family</h1><p class="kiosk-lede">Which learning path would you like to explore?</p>
    <div class="kiosk-choice-grid kiosk-pathway-grid" role="group" aria-label="Choose a track family">
      <button class="kiosk-choice-card kiosk-pathway-card ${kioskDraft.pathway === "academic" ? "selected" : ""}" data-kiosk-action="select-pathway" data-value="academic" aria-pressed="${kioskDraft.pathway === "academic"}"><span class="kiosk-choice-icon">${icon("book")}</span><span class="kiosk-choice-copy"><strong>Academic track</strong><small>STEM, Business and Entrepreneurship, and ASSH</small></span><span class="kiosk-choice-check">${icon("checkmark")}</span></button>
      <button class="kiosk-choice-card kiosk-pathway-card ${kioskDraft.pathway === "techpro" ? "selected" : ""}" data-kiosk-action="select-pathway" data-value="techpro" aria-pressed="${kioskDraft.pathway === "techpro"}"><span class="kiosk-choice-icon">${icon("laptop")}</span><span class="kiosk-choice-copy"><strong>TechPro</strong><small>Programming, design, animation and bakery</small></span><span class="kiosk-choice-check">${icon("checkmark")}</span></button>
    </div><div class="kiosk-note">${icon("sparkle")} You can review your choices before getting a ticket.</div>
  </div>`;

  if (kioskDraft.step === "track") {
    const isGrade12 = kioskDraft.grade === "12";
    const trackNote = isGrade12
      ? "Choose the track you previously studied."
      : kioskDraft.pathway === "academic" && (!kioskDraft.track || kioskDraft.track === "STEM")
        ? "STEM requires a minimum grade of 90 in every Grade 10 subject. If you do not meet this, talk to the teacher in charge."
        : kioskDraft.track ? `Your ${kioskDraft.track} choice will be included with your queue ticket.`
          : "Your selection will be included with your queue ticket.";
    return `<div class="kiosk-step-content" key="track">
      <div class="kiosk-section-kicker">TICKET FORM · STEP ${isGrade12 ? "3 OF 4" : "4 OF 5"} · INCOMING GRADE ${esc(kioskDraft.grade)}</div><h1>${isGrade12 ? "What track were you in before?" : `Choose your ${kioskDraft.pathway === "academic" ? "academic" : "TechPro"} track`}</h1><p class="kiosk-lede">${isGrade12 ? "Select the track you are continuing from." : "Choose the option that best fits your plans."}</p>
      ${isGrade12 ? `<div class="kiosk-track-filters" role="group" aria-label="Filter track family"><button class="kiosk-filter ${kioskTrackFilter === "academic" ? "active" : ""}" data-kiosk-action="track-filter" data-value="academic" aria-pressed="${kioskTrackFilter === "academic"}">Academic track</button><button class="kiosk-filter ${kioskTrackFilter === "techpro" ? "active" : ""}" data-kiosk-action="track-filter" data-value="techpro" aria-pressed="${kioskTrackFilter === "techpro"}">TechPro</button></div>` : ""}
      <div class="kiosk-choice-grid kiosk-track-grid" role="group" aria-label="Choose a track">${kioskTrackCards()}</div>
      <div class="kiosk-note">${icon("info")} ${esc(trackNote)}</div>
    </div>`;
  }

  return `<div class="kiosk-step-content" key="review">
    <div class="kiosk-section-kicker">FINAL TICKET STEP · REVIEW</div><h1>Ready to join the line?</h1><p class="kiosk-lede">Check the student's grade and preferred track, then take a Step 1 teacher-queue ticket.</p>
    <div class="kiosk-review-card"><span class="kiosk-review-icon">${icon("ticket")}</span><div><small>STUDENT DETAILS</small><strong>Incoming Grade ${esc(kioskDraft.grade)}</strong><span>${esc(kioskDraft.pathway === "academic" ? "Academic track" : "TechPro")} · ${esc(kioskDraft.track)}</span></div><span class="kiosk-review-check">${icon("checkmark")}</span></div>
    <div class="kiosk-note">${icon("shield")} We only save the grade and track with the queue ticket. No student name or ID is needed.</div>
  </div>`;
}

function kioskStepSidebar() {
  const steps = [{ id: "prerequisites", label: "Preparation" }, ...(kioskDraft.grade === "11"
    ? [{ id: "grade", label: "Grade level" }, { id: "pathway", label: "Track family" }, { id: "track", label: "Preferred track" }, { id: "review", label: "Review & ticket" }]
    : kioskDraft.grade === "12"
      ? [{ id: "grade", label: "Grade level" }, { id: "track", label: "Previous track" }, { id: "review", label: "Review & ticket" }]
      : [{ id: "grade", label: "Grade level" }, { id: "track", label: "Preferred track" }, { id: "review", label: "Review & ticket" }])];
  const currentIndex = steps.findIndex((step) => step.id === kioskDraft.step);
  return `<nav class="kiosk-steps" aria-label="Ticket steps">${steps.map((step, index) => `<div class="kiosk-step-item ${step.id === kioskDraft.step ? "current" : index < currentIndex ? "complete" : ""}" ${step.id === kioskDraft.step ? 'aria-current="step"' : ""}><span class="kiosk-step-number">${index < currentIndex ? icon("checkmark") : String(index + 1).padStart(2, "0")}</span><span>${step.label}</span></div>`).join("")}</nav>`;
}

function ticketProgressView(ticket) {
  const progress = ticket.progress || {};
  const stage = processStage(ticket);
  const stateClass = (key, complete) => complete ? "done" : stage === key ? "current" : "pending";
  const teacherLabel = ticket.status === "CALLED" && stage === "teacher" ? "Called to teacher" : ticket.status === "IN_SERVICE" && stage === "teacher" ? "Meeting in progress" : "Teacher meeting";
  const message = stage === "teacher"
    ? ticket.status === "CALLED" ? "Your number was called. Please go to the teacher station." : ticket.status === "IN_SERVICE" ? "Your teacher meeting is in progress." : "Wait in the Step 1 area for your number to be called."
    : stage === "brigada" ? "After your teacher meeting, complete the Step 1 Brigada sign-off. Then proceed to Step 2 room assignment."
      : stage === "room" ? "Step 1 is complete. You’re ready for Step 2: room assignment."
        : stage === "done" ? "Room assigned. Your enrollment steps are complete."
          : "Complete the remaining preparation requirement before requesting a ticket.";
  const item = (label, key, complete, currentLabel = "Current") => `<li class="ticket-progress-item ${stateClass(key, complete)}"><span class="ticket-progress-mark">${complete ? icon("checkmark") : icon(key === stage ? "clock" : "caret")}</span><span>${label}</span><small>${complete ? "Complete" : key === stage ? currentLabel : "Upcoming"}</small></li>`;
  return `<section class="ticket-progress" aria-label="Enrollment progress"><div class="ticket-progress-head"><div><small>YOUR CURRENT STEP</small><strong>${esc(processStageLabel(ticket))}</strong></div><span class="ticket-progress-code">${icon("queue")} #${String(ticket.queueOrder).padStart(3, "0")}</span></div><p class="ticket-progress-message">${message}</p>${ticket.roomLabel ? `<p class="ticket-progress-message"><strong>Assigned room:</strong> ${esc(ticket.roomLabel)}</p>` : ""}<div class="ticket-progress-grid"><div class="ticket-progress-stage"><span class="ticket-stage-label">STEP 1 · TEACHER MEETING + BRIGADA</span><ul>${item("Documents checked", "documents", Boolean(progress.documentsChecked))}${item("Orientation video", "orientation", Boolean(progress.orientationComplete))}${item(teacherLabel, "teacher", Boolean(progress.teacherComplete), ticket.status === "WAITING" ? "Waiting" : "Proceed")}${item("Brigada sign-off", "brigada", Boolean(progress.brigadaComplete), "Required to finish Step 1")}</ul></div><div class="ticket-progress-stage"><span class="ticket-stage-label">STEP 2 · ROOM ASSIGNMENT</span><ul>${item("Room assignment", "room", Boolean(progress.roomAssigned), "Ready")}</ul></div></div></section>`;
}

function kioskTicketResult(ticket) {
  return `<div class="kiosk-issued-wrap"><section class="kiosk-issued-card" aria-label="Your queue ticket"><div class="kiosk-success-mark">${icon("checkmark")}</div><p class="kiosk-section-kicker">YOUR STEP 1 TICKET IS READY</p><h1>You're in line.</h1><p class="kiosk-lede">Keep this ticket number. Wait in the Step 1 area and watch for it to be called.</p><div class="kiosk-ticket-number">${esc(ticket.publicCode)}</div><div class="kiosk-ticket-details"><span><small>INCOMING GRADE</small><strong>${esc(ticket.grade || "—")}</strong></span><span><small>PREFERRED TRACK</small><strong>${esc(ticket.track || "Discuss with teacher")}</strong></span><span><small>QUEUE POSITION</small><strong>#${String(ticket.queueOrder).padStart(3, "0")}</strong></span></div>${ticketProgressView(ticket)}<p class="kiosk-ticket-hint">${icon("speaker")} Watch the public display for your number and destination.</p></section><div class="kiosk-issued-actions"><button class="button button-secondary kiosk-large-button" data-action="print-ticket">${icon("printer")}Print ticket</button><button class="button button-primary kiosk-large-button" data-action="new-student">${icon("plus")}Next student</button></div><p class="kiosk-reset-copy">Starting the next ticket keeps this one in the queue.</p></div>`;
}

function ticketView() {
  const ticket = getMyTicket();
  const canIssue = state.session.status === "ACTIVE";
  if (ticket) return `<div class="kiosk-shell"><header class="kiosk-header"><div class="kiosk-brand"><span class="kiosk-brand-mark">${icon("sparkle")}</span><span><strong>enroll</strong><small>Student + parent kiosk</small></span></div><div class="kiosk-header-session"><span class="kiosk-live-dot"></span><span><strong>${esc(state.session.name)}</strong><small>${esc(state.session.station)}</small></span></div><button class="kiosk-help-button" data-action="kiosk-help">${icon("question")}<span>Need help?</span></button></header><main class="kiosk-issued-main">${kioskTicketResult(ticket)}</main><footer class="kiosk-footer"><span>${icon("calendar")} ${dateLabel()}</span><span>Need assistance? Please ask a staff member.</span><span>${icon("lock")} Secure enrollment queue</span></footer></div>`;
  const isReady = kioskDraft.step === "prerequisites" ? Boolean(kioskDraft.documentsChecked && kioskDraft.orientationComplete)
    : kioskDraft.step === "grade" ? Boolean(kioskDraft.grade)
    : kioskDraft.step === "pathway" ? Boolean(kioskDraft.pathway)
      : kioskDraft.step === "track" ? Boolean(kioskDraft.track)
        : Boolean(kioskDraft.grade && kioskDraft.pathway && kioskDraft.track);
  const actionLabel = kioskDraft.step === "review" ? "Get my queue ticket" : "Continue";
  const actionIcon = kioskDraft.step === "review" ? "ticket" : "arrow";
  return `<div class="kiosk-shell">
    <header class="kiosk-header"><div class="kiosk-brand"><span class="kiosk-brand-mark">${icon("sparkle")}</span><span><strong>enroll</strong><small>Student + parent kiosk</small></span></div><div class="kiosk-header-session"><span class="kiosk-live-dot"></span><span><strong>${esc(state.session.name)}</strong><small>${esc(state.session.station)} · ${waitingTickets().length} waiting</small></span></div><button class="kiosk-help-button" data-action="kiosk-help">${icon("question")}<span>Need help?</span></button></header>
    ${!canIssue ? `<div class="kiosk-closed-banner">${icon("warning")}<span>${state.session.status === "PAUSED" ? "Ticket requests are paused. Please ask the enrollment team for help." : "This enrollment session is closed. Please ask the enrollment team about the next session."}</span></div>` : ""}
    <main class="kiosk-layout"><aside class="kiosk-sidebar"><p class="kiosk-sidebar-label">STEP 1 TICKET</p><h2>${kioskDraft.grade === "11" ? "Five" : kioskDraft.grade === "12" ? "Four" : "A few"} quick steps</h2><p class="kiosk-sidebar-copy">Complete document check and orientation first, then get your place in the teacher queue.</p>${kioskStepSidebar()}<div class="kiosk-sidebar-bottom"><span class="kiosk-sidebar-icon">${icon("shield")}</span><span><strong>Your privacy matters</strong><small>No name, ID, or account needed.</small></span></div></aside>
      <section class="kiosk-content-card"><div class="kiosk-content-top"><span>${icon("pin")} ${esc(state.session.station)}</span><span>About 1 minute</span></div>${kioskStepContent()}<div class="kiosk-footer-actions"><button class="kiosk-back-button" data-kiosk-action="back" ${kioskDraft.step === "prerequisites" ? "disabled" : ""}>${icon("leftArrow")}Back</button><span class="kiosk-footer-hint">${kioskDraft.step === "review" ? "Your place is saved as soon as you get a ticket." : "Tap a card to make your selection."}</span><button class="button button-primary kiosk-continue-button" data-kiosk-action="continue" ${!canIssue || !isReady ? "disabled" : ""}>${actionLabel}${icon(actionIcon)}</button></div></section>
      <aside class="kiosk-summary"><div class="kiosk-summary-head"><span>${icon("receipt")}</span><div><strong>Your selection</strong><small>Review as you go</small></div></div><div class="kiosk-summary-lines"><div class="kiosk-summary-line"><span>Incoming grade</span><strong>${kioskDraft.grade ? `Grade ${esc(kioskDraft.grade)}` : "Not selected"}</strong></div><div class="kiosk-summary-line"><span>Track family</span><strong>${kioskDraft.pathway ? esc(kioskDraft.pathway === "academic" ? "Academic track" : "TechPro") : "Not selected"}</strong></div><div class="kiosk-summary-line"><span>Track</span><strong>${esc(kioskDraft.track || "Not selected")}</strong></div></div><div class="kiosk-summary-wait"><span>${icon("users")}</span><div><small>Ready for teacher</small><strong>${teacherReadyTickets().length}</strong></div></div><p class="kiosk-summary-note">${icon("info")} Your ticket number will be called at ${esc(state.session.station)}.</p></aside>
    </main><footer class="kiosk-footer"><span>${icon("calendar")} ${dateLabel()}</span><span>Need assistance? Please ask a staff member.</span><span>${icon("lock")} Secure enrollment queue</span></footer>
  </div>`;
}

function displayView() {
  const ticket = currentTicket();
  const called = state.events.filter((event) => event.type === "TICKET_CALLED").slice(0, 3);
  const callMessage = ticket?.status === "CALLED" ? `Ticket ${esc(ticket.publicCode)}, please proceed to ${esc(state.session.station)}.` : ticket ? `Ticket ${esc(ticket.publicCode)} is at the teacher meeting.` : "No one waiting — the queue is clear.";
  const view = `<div class="display-page ${ticket ? "" : "display-empty"}"><header class="display-header"><div class="display-brand"><span class="brand-mark">${icon("sparkle")}</span><span>ENROLL · PUBLIC DISPLAY</span></div><div class="display-header-actions"><button class="button" data-action="toggle-speech" aria-pressed="${displaySpeechEnabled}">${icon(displaySpeechEnabled ? "speaker" : "mute")}<span>${displaySpeechEnabled ? "Announcements on" : "Enable announcements"}</span></button><button class="button" data-action="fullscreen">${icon("expand")}<span>Full screen</span></button><button class="button" data-action="back-dashboard">${icon("dashboard")}<span>Staff view</span></button></div></header><main class="display-main"><div class="display-overline">${icon("broadcast")} Step 1 · Teacher queue</div><h1>Now serving</h1><p class="display-station">${esc(state.session.station)} <span aria-hidden="true">·</span> ${esc(state.session.name)}</p><section class="display-ticket-card" aria-live="polite"><span class="display-label">Please proceed to the teacher station</span><span class="display-code ${ticket ? "updated" : ""}" id="display-code">${ticket ? esc(ticket.publicCode) : ""}</span><p class="display-message" id="display-message">${callMessage}</p><div class="display-meta"><span>${icon("pin")} ${esc(state.session.station)}</span><span>${icon("users")} ${teacherReadyTickets().length} ready for Step 1</span></div></section></main><footer class="display-bottom"><span class="display-connection">${cloudMode ? "Live shared queue connected" : "This browser demo is connected"}</span><span>Last called ${called[0] ? `<strong>${esc(called[0].ticketCode)} · ${timeLabel(called[0].createdAt)}</strong>` : "—"}</span></footer></div>`;
  return view;
}

function setupView() {
  const isActive = state.session.status === "ACTIVE";
  const isPaused = state.session.status === "PAUSED";
  const content = `<div class="page-heading"><div><p class="eyebrow">Manage enrollment</p><h1>Session setup</h1><p class="page-subtitle">Configure today’s session and service counter.</p></div><div class="heading-actions"><span class="session-indicator ${activeSessionClass()}">${sessionStatusLabel()}</span></div></div><div class="setup-wrap"><form class="view-card setup-form" id="setup-form"><h2>Session details</h2><p>These details are shown on student tickets and the public display.</p><div class="form-group"><label for="session-name">Session name</label><input id="session-name" name="sessionName" maxlength="60" value="${esc(state.session.name)}" required /><span class="form-help">A short label students can recognize.</span></div><div class="form-group"><label for="station-name">Station label</label><input id="station-name" name="stationName" maxlength="60" value="${esc(state.session.station)}" required /><span class="form-help">For example: Step 1 — Counter 1.</span></div><div class="form-actions"><button class="button button-primary" type="submit">${icon("save")}Save changes</button><button class="button button-secondary" type="button" data-nav="dashboard">Back to queue</button></div></form><aside class="view-card setup-info"><h2>Session controls</h2><p>${isActive ? "Pause ticket requests while keeping the queue and current service intact." : isPaused ? "Resume ticket requests when the enrollment desk is ready." : "This session is closed. You can still review the queue history."}</p><div class="session-controls">${isActive ? `<button class="button button-secondary" data-action="pause-session">${icon("pause")}Pause ticket requests</button>` : isPaused ? `<button class="button button-primary" data-action="resume-session">${icon("play")}Resume ticket requests</button>` : `<button class="button button-secondary" disabled>${icon("close")}Session closed</button>`}<button class="button button-secondary" data-action="open-display">${icon("display")}Open public display</button>${state.session.status !== "CLOSED" ? `<button class="button button-quiet" data-action="confirm-close">${icon("close")}Close session</button>` : ""}</div><div class="setup-note">${cloudMode ? "Session settings are shared through Supabase and protected by staff sign-in." : "This local demo saves changes in this browser only. Staff sign-in, persistent database storage, and server-side permissions must be connected before real enrollment data is used."}</div></aside></div>`;
  return shell(content, "setup");
}

function adminView() {
  const waiting = teacherReadyTickets().length;
  const active = currentTicket();
  const issued = state.tickets.filter((ticket) => ticket.status !== "CANCELLED").length;
  const statusCopy = state.session.status === "ACTIVE" ? "Students can request tickets" : state.session.status === "PAUSED" ? "Ticket requests are paused" : "This session is closed";
  const statusAction = state.session.status === "ACTIVE"
    ? `<button class="button button-secondary" data-action="pause-session">${icon("pause")}Pause requests</button>`
    : state.session.status === "PAUSED"
      ? `<button class="button button-primary" data-action="resume-session">${icon("play")}Resume requests</button>`
      : `<button class="button button-secondary" disabled>${icon("close")}Session closed</button>`;
  const content = `<div class="page-heading"><div><p class="eyebrow">Administrator${cloudMode ? "" : " · Preview"}</p><h1>Admin console</h1><p class="page-subtitle">Manage enrollment sessions, service stations, and staff access.</p></div><div class="heading-actions"><span class="demo-pill">${icon(cloudMode ? "shield" : "info")}${cloudMode ? "Admin role" : "Demo role"}</span><button class="button button-primary" data-nav="setup">${icon("edit")}Edit session</button></div></div>
    <div class="metrics admin-metrics">
      <article class="metric-card"><div class="metric-top"><span>Session status</span><span class="metric-icon">${icon("broadcast")}</span></div><strong class="metric-value admin-metric-status">${state.session.status === "ACTIVE" ? "Active" : state.session.status === "PAUSED" ? "Paused" : "Closed"}</strong><span class="metric-caption">${statusCopy}</span></article>
      <article class="metric-card"><div class="metric-top"><span>Tickets issued</span><span class="metric-icon">${icon("ticket")}</span></div><strong class="metric-value">${issued}</strong><span class="metric-caption">Across this session</span></article>
      <article class="metric-card"><div class="metric-top"><span>Waiting for teacher</span><span class="metric-icon">${icon("users")}</span></div><strong class="metric-value">${waiting}</strong><span class="metric-caption">${waiting ? `Next · ${esc(teacherReadyTickets()[0].publicCode)}` : "Queue is clear"}</span></article>
      <article class="metric-card"><div class="metric-top"><span>Service stations</span><span class="metric-icon">${icon("pin")}</span></div><strong class="metric-value">1</strong><span class="metric-caption">${esc(state.session.station)}</span></article>
    </div>
    <div class="admin-grid">
      <section class="panel admin-session-card"><div class="panel-head"><div><h2 class="panel-title">Current enrollment session</h2><p class="panel-subtitle">Session details and queue health</p></div><span class="session-indicator ${activeSessionClass()}">${sessionStatusLabel()}</span></div>
        <div class="admin-session-name"><span class="detail-icon">${icon("calendar")}</span><div><small>Session name</small><strong>${esc(state.session.name)}</strong></div></div>
        <div class="admin-session-facts"><div><span>Station</span><strong>${esc(state.session.station)}</strong></div><div><span>Currently at teacher station</span><strong>${active ? `${esc(active.publicCode)} · ${statusLabel(active.status)}` : "Station available"}</strong></div><div><span>Next waiting</span><strong>${teacherReadyTickets()[0] ? esc(teacherReadyTickets()[0].publicCode) : "No one waiting"}</strong></div></div>
        <div class="admin-actions">${statusAction}<button class="button button-secondary" data-nav="setup">${icon("sliders-horizontal")}Session settings</button>${state.session.status !== "CLOSED" ? `<button class="button button-quiet" data-action="confirm-close">${icon("close")}Close session</button>` : ""}</div>
      </section>
      <section class="panel admin-access-card"><div class="panel-head"><div><h2 class="panel-title">Roles &amp; access</h2><p class="panel-subtitle">Who can manage this queue</p></div><span class="admin-access-badge">${cloudMode ? "Connected" : "Preview"}</span></div>
        <div class="role-list"><div class="role-row"><span class="role-icon admin-role-icon">${icon("admin")}</span><div><strong>Administrator</strong><small>Session setup, station settings, and staff access</small></div><span class="role-count">1 role</span></div><div class="role-row"><span class="role-icon staff-role-icon">${icon("users")}</span><div><strong>Staff</strong><small>Call, serve, complete, recall, and skip tickets</small></div><span class="role-count">1 role</span></div><div class="role-row"><span class="role-icon student-role-icon">${icon("ticket")}</span><div><strong>Student</strong><small>Request a ticket without signing in</small></div><span class="role-count">Public</span></div></div>
        <div class="admin-access-footer"><span>${icon("lock")} ${cloudMode ? "Staff roles are checked by Supabase." : "Role checks are not connected in this demo."}</span><button class="subtle-button" data-action="role-access-info">Access details ${icon("arrow")}</button></div>
      </section>
      <section class="panel admin-activity-card"><div class="panel-head"><div><h2 class="panel-title">Latest queue activity</h2><p class="panel-subtitle">Recent actions in this session</p></div><button class="panel-link" data-nav="dashboard">Open queue ${icon("arrow")}</button></div><div class="admin-activity-list">${state.events.slice(0, 4).map(activityLine).join("") || '<div class="activity-empty">Queue activity will appear here.</div>'}</div></section>
      <aside class="admin-note">${icon("shield")}<span><strong>${cloudMode ? "Shared admin console." : "Local admin preview."}</strong> ${cloudMode ? "Queue data and staff actions are stored in the shared database." : "Changes are saved in this browser. Connect staff sign-in and server-side role checks before using admin controls with real enrollment data."}</span></aside>
    </div>`;
  return shell(content, "admin");
}

function render() {
  const view = currentView();
  document.body.classList.toggle("display-mode", view === "display");
  document.body.classList.toggle("kiosk-mode", view === "ticket");
  document.title = `${view === "display" ? "Public display" : esc(VIEW_NAMES[view])} · Enroll`;
  if (cloudMode && remoteStatus !== "ready") {
    app.innerHTML = connectionView();
    bindCloudGateEvents();
    return;
  }
  if (cloudMode && view === "password") {
    app.innerHTML = passwordSetupView();
    bindPasswordSetupEvents();
    return;
  }
  if (cloudMode && !["ticket", "display"].includes(view) && (!remoteAuthSession || !remoteStaffRole)) {
    app.innerHTML = staffAuthView();
    bindCloudGateEvents();
    return;
  }
  if (cloudMode && ["admin", "setup"].includes(view) && remoteStaffRole !== "admin") {
    app.innerHTML = staffAuthView();
    bindCloudGateEvents();
    return;
  }
  app.innerHTML = view === "dashboard" ? dashboardView() : view === "ticket" ? ticketView() : view === "display" ? displayView() : view === "admin" ? adminView() : setupView();
  bindViewEvents(view);
  if (view === "display") observeAnnouncement();
}

function recordEvent(type, ticketCode = "") {
  const event = { id: makeId(), type, ticketCode, createdAt: new Date().toISOString() };
  state.events.unshift(event);
  state.events = state.events.slice(0, 100);
  return event;
}

function makeId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `e-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function makePublicCode() {
  const used = new Set(state.tickets.map((ticket) => ticket.publicCode));
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const bytes = new Uint32Array(1);
    if (globalThis.crypto?.getRandomValues) crypto.getRandomValues(bytes);
    else bytes[0] = Math.floor(Math.random() * 0xffffffff);
    const number = String(100000 + (bytes[0] % 900000));
    const code = `EN-${number}`;
    if (!used.has(code)) return code;
  }
  throw new Error("A unique ticket code could not be created. Please try again.");
}

function issueTicket(selection = kioskDraft) {
  if (state.session.status !== "ACTIVE") return showToast("Ticket requests are not available right now.", "error");
  if (getMyTicket()) return showToast("You already have a ticket on this device.");
  if (!selection.documentsChecked || !selection.orientationComplete) return showToast("Complete document check and orientation before getting a Step 1 ticket.", "error");
  if (!selection.grade || !selection.pathway || !selection.track) return showToast("Choose a grade and track before getting a ticket.", "error");
  if (cloudMode) return runRemoteTicketIssue(selection);
  try {
    const ticket = { id: makeId(), publicCode: makePublicCode(), queueOrder: state.nextQueueOrder++, status: "WAITING", grade: `Grade ${selection.grade}`, pathway: selection.pathway === "academic" ? "Academic track" : "TechPro", track: selection.track, progress: { documentsChecked: true, orientationComplete: true, teacherComplete: false, brigadaComplete: false, roomAssigned: false, teacherCompletedAt: null, brigadaCompletedAt: null }, callCount: 0, createdAt: new Date().toISOString(), calledAt: null, serviceStartedAt: null, completedAt: null };
    state.tickets.push(ticket);
    sessionStorage.setItem("enroll-my-ticket", ticket.id);
    recordEvent("TICKET_CREATED", ticket.publicCode);
    persistState();
    showToast(`${ticket.publicCode} is now in the queue.`);
  } catch (error) { showToast(error.message || "Could not issue a ticket.", "error"); }
}

function callNext({ fromCompletion = false } = {}) {
  if (cloudMode) return runRemoteAction("call_next").then((ok) => {
    if (ok) showToast(`${currentTicket()?.publicCode || "Next ticket"} has been called to the teacher station.`);
  });
  if (state.session.status === "CLOSED") return showToast("This session is closed.", "error");
  if (state.currentTicketId && !fromCompletion) return showToast("Finish or skip the ticket at the counter first.", "error");
  const next = teacherReadyTickets()[0];
  if (!next) {
    if (fromCompletion) { state.currentTicketId = null; persistState(); }
    return showToast(waitingTickets().length ? "Complete document check and orientation before the teacher meeting." : "No one is waiting right now.");
  }
  next.status = "CALLED";
  next.calledAt = new Date().toISOString();
  next.callCount = (next.callCount || 0) + 1;
  state.currentTicketId = next.id;
  recordEvent("TICKET_CALLED", next.publicCode);
  persistState();
  showToast(`${next.publicCode} has been called to the teacher station.`);
}

function startService() {
  if (cloudMode) return runRemoteAction("start_service").then((ok) => { if (ok) showToast("Teacher meeting started."); });
  const ticket = currentTicket();
  if (!ticket || ticket.status !== "CALLED") return showToast("There isn’t a called ticket ready to start.", "error");
  ticket.status = "IN_SERVICE";
  ticket.serviceStartedAt = new Date().toISOString();
  recordEvent("SERVICE_STARTED", ticket.publicCode);
  persistState();
  showToast(`Teacher meeting started for ${ticket.publicCode}.`);
}

function completeAndCallNext() {
  if (cloudMode) {
    const completedCode = currentTicket()?.publicCode || "Ticket";
    return runRemoteAction("complete_teacher").then((ok) => {
      if (ok) showToast(`${completedCode} completed the teacher meeting. Brigada is still required to finish Step 1.${currentTicket() ? ` ${currentTicket().publicCode} is next.` : ""}`);
    });
  }
  const ticket = currentTicket();
  if (!ticket || ticket.status !== "IN_SERVICE") return showToast("Start service before completing this ticket.", "error");
  ticket.status = "COMPLETED";
  ticket.progress.teacherComplete = true;
  ticket.completedAt = new Date().toISOString();
  ticket.progress.teacherCompletedAt = ticket.completedAt;
  recordEvent("TEACHER_MEETING_COMPLETED", ticket.publicCode);
  state.currentTicketId = null;
  const next = teacherReadyTickets()[0];
  if (next) {
    next.status = "CALLED";
    next.calledAt = new Date().toISOString();
    next.callCount = (next.callCount || 0) + 1;
    state.currentTicketId = next.id;
    recordEvent("TICKET_CALLED", next.publicCode);
  }
  persistState();
  showToast(`${ticket.publicCode} completed the teacher meeting. Brigada is still required to finish Step 1.${next ? ` ${next.publicCode} is next.` : ""}`);
}

function advancePostTeacherStage(ticketId, stage) {
  if (cloudMode) {
    const ticket = state.tickets.find((item) => item.id === ticketId);
    const code = ticket?.publicCode || "Ticket";
    const action = stage === "brigada" ? "complete_brigada" : "assign_room";
    return runRemoteAction(action, ticketId).then((ok) => {
      if (!ok) return;
      const updated = state.tickets.find((item) => item.id === ticketId);
      showToast(stage === "brigada" ? `${code} completed Brigada. Step 1 is complete; the ticket is ready for Step 2 room assignment.` : `${code} is assigned to ${updated?.roomLabel || "its room"}.`);
    });
  }
  const ticket = state.tickets.find((item) => item.id === ticketId);
  if (!ticket || processStage(ticket) !== stage) return showToast("This ticket isn’t ready for that sign-off.", "error");
  if (stage === "room" && !isFirstAtStage(ticket, stage)) return showToast("Please assign the earlier eligible ticket first.", "error");
  if (stage === "brigada") {
    ticket.progress.brigadaComplete = true;
    ticket.progress.brigadaCompletedAt = new Date().toISOString();
    recordEvent("BRIGADA_COMPLETED", ticket.publicCode);
    persistState();
    return showToast(`${ticket.publicCode} completed Brigada. Step 1 is complete; the ticket is ready for Step 2 room assignment.`);
  }
  if (stage === "room") {
    ticket.progress.roomAssigned = true;
    recordEvent("ROOM_ASSIGNED", ticket.publicCode);
    persistState();
    return showToast(`A room has been assigned to ${ticket.publicCode}.`);
  }
}

function recallCurrent() {
  if (cloudMode) return runRemoteAction("recall").then((ok) => { if (ok) showToast(`${currentTicket()?.publicCode || "Ticket"} was recalled.`); });
  const ticket = currentTicket();
  if (!ticket) return showToast("There’s no current ticket to recall.", "error");
  ticket.callCount = (ticket.callCount || 0) + 1;
  ticket.calledAt = new Date().toISOString();
  recordEvent("TICKET_RECALLED", ticket.publicCode);
  persistState();
  showToast(`${ticket.publicCode} was recalled.`);
}

function skipCurrent() {
  if (cloudMode) return runRemoteAction("skip_current").then((ok) => { if (ok) showToast("Ticket marked as a no-show."); });
  const ticket = currentTicket();
  if (!ticket || ticket.status !== "CALLED") return showToast("Only a called ticket can be marked as a no-show.", "error");
  ticket.status = "SKIPPED";
  ticket.skippedAt = new Date().toISOString();
  recordEvent("TICKET_SKIPPED", ticket.publicCode);
  state.currentTicketId = null;
  const next = teacherReadyTickets()[0];
  if (next) {
    next.status = "CALLED";
    next.calledAt = new Date().toISOString();
    next.callCount = (next.callCount || 0) + 1;
    state.currentTicketId = next.id;
    recordEvent("TICKET_CALLED", next.publicCode);
  }
  persistState();
  showToast(next ? `${ticket.publicCode} marked no-show. ${next.publicCode} is next.` : `${ticket.publicCode} marked no-show.`);
}

function setSessionStatus(status) {
  if (cloudMode) return runRemoteAction("set_session_status", null, { status }).then((ok) => {
    if (ok) showToast(status === "ACTIVE" ? "Ticket requests are open." : status === "PAUSED" ? "Ticket requests are paused." : "Session closed.");
  });
  if (status === "CLOSED" && currentTicket()) return showToast("Complete or skip the ticket at the counter before closing the session.", "error");
  state.session.status = status;
  recordEvent(`SESSION_${status}`, "");
  persistState();
  showToast(status === "ACTIVE" ? "Ticket requests are open." : status === "PAUSED" ? "Ticket requests are paused." : "Session closed.");
}

function showToast(message, type = "success") {
  const region = document.getElementById("toast-region");
  if (!region) return;
  clearTimeout(toastTimer);
  region.innerHTML = `<div class="toast ${type === "error" ? "error" : ""}" role="status">${icon(type === "error" ? "warning" : "check")}<span>${esc(message)}</span></div>`;
  toastTimer = setTimeout(() => {
    const toast = region.querySelector(".toast");
    if (toast) {
      toast.classList.add("fade-out");
      setTimeout(() => { if (toast.isConnected) toast.remove(); }, 310);
    }
  }, 2700);
}

function askForConfirmation({ title, copy, confirmLabel, action, danger = true }) {
  document.getElementById("dialog-title").textContent = title;
  document.getElementById("dialog-copy").textContent = copy;
  dialogConfirm.textContent = confirmLabel;
  dialogConfirm.className = `button ${danger ? "button-danger" : "button-primary"}`;
  pendingConfirmAction = action;
  if (typeof dialog.showModal === "function") dialog.showModal();
  else if (window.confirm(copy)) runConfirmedAction();
}

function runConfirmedAction() {
  const action = pendingConfirmAction;
  pendingConfirmAction = null;
  if (action) action();
}

function updateQueueRows() {
  const body = document.getElementById("queue-list");
  if (body) body.innerHTML = queueRowsHtml();
}

function bindViewEvents(view) {
  app.querySelectorAll("[data-nav]").forEach((button) => button.addEventListener("click", () => goToView(button.dataset.nav)));
  app.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", () => handleAction(button.dataset.action, button.dataset.ticketId || "")));
  app.querySelectorAll("[data-kiosk-action]").forEach((button) => button.addEventListener("click", () => handleKioskAction(button.dataset.kioskAction, button.dataset.value)));
  app.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("click", () => {
    activeFilter = button.dataset.filter;
    app.querySelectorAll("[data-filter]").forEach((item) => item.classList.toggle("active", item === button));
    updateQueueRows();
  }));
  const search = document.getElementById("queue-search");
  if (search) search.addEventListener("input", () => { searchQuery = search.value; updateQueueRows(); });
  const form = document.getElementById("setup-form");
  if (form) form.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const name = String(data.get("sessionName") || "").trim();
    const station = String(data.get("stationName") || "").trim();
    if (!name || !station) return showToast("Add a session name and station label.", "error");
    if (cloudMode) {
      runRemoteAction("update_session", null, { name, station }).then((ok) => { if (ok) showToast("Session details saved."); });
      return;
    }
    state.session.name = name;
    state.session.station = station;
    persistState();
    showToast("Session details saved.");
  });
  if (view === "display") {
    const code = document.getElementById("display-code");
    if (code) requestAnimationFrame(() => code.classList.add("updated"));
  }
}

function handleKioskAction(action, value = "") {
  switch (action) {
    case "select-grade":
      kioskDraft = { ...kioskDraft, grade: value, pathway: "", track: "", step: "grade" };
      kioskTrackFilter = "academic";
      render();
      break;
    case "toggle-prerequisite":
      if (value === "documentsChecked" || value === "orientationComplete") kioskDraft[value] = !kioskDraft[value];
      render();
      break;
    case "select-pathway":
      kioskDraft.pathway = value;
      kioskDraft.track = "";
      render();
      break;
    case "track-filter":
      kioskTrackFilter = value;
      if (kioskDraft.track && (value === "academic") !== academicTracks.includes(kioskDraft.track)) kioskDraft.track = "";
      render();
      break;
    case "select-track":
      kioskDraft.track = value;
      if (kioskDraft.grade === "12") kioskDraft.pathway = academicTracks.includes(value) ? "academic" : "techpro";
      render();
      break;
    case "continue":
      if (kioskDraft.step === "prerequisites" && kioskDraft.documentsChecked && kioskDraft.orientationComplete) kioskDraft.step = "grade";
      else if (kioskDraft.step === "grade" && kioskDraft.grade) kioskDraft.step = kioskDraft.grade === "11" ? "pathway" : "track";
      else if (kioskDraft.step === "pathway" && kioskDraft.pathway) kioskDraft.step = "track";
      else if (kioskDraft.step === "track" && kioskDraft.track) kioskDraft.step = "review";
      else if (kioskDraft.step === "review") return issueTicket(kioskDraft);
      render();
      break;
    case "back":
      if (kioskDraft.step === "review") kioskDraft.step = "track";
      else if (kioskDraft.step === "track") kioskDraft.step = kioskDraft.grade === "11" ? "pathway" : "grade";
      else if (kioskDraft.step === "pathway") kioskDraft.step = "grade";
      else if (kioskDraft.step === "grade") kioskDraft.step = "prerequisites";
      render();
      break;
    default: break;
  }
}

function handleAction(action, ticketId = "") {
  switch (action) {
    case "open-menu": mobileMenuOpen = true; render(); break;
    case "close-menu": mobileMenuOpen = false; render(); break;
    case "go-ticket": goToView("ticket"); break;
    case "call-next": callNext(); break;
    case "start-service": startService(); break;
    case "complete-next": completeAndCallNext(); break;
    case "complete-brigada": advancePostTeacherStage(ticketId, "brigada"); break;
    case "assign-room": advancePostTeacherStage(ticketId, "room"); break;
    case "recall": recallCurrent(); break;
    case "confirm-skip": askForConfirmation({ title: "Skip this ticket?", copy: "This will mark the current ticket as a no-show, keep it in the event history, and call the next student if someone is waiting.", confirmLabel: "Skip & call next", action: skipCurrent }); break;
    case "pause-session": setSessionStatus("PAUSED"); break;
    case "resume-session": setSessionStatus("ACTIVE"); break;
    case "confirm-close": askForConfirmation({ title: "Close this session?", copy: "Students will no longer be able to request tickets. You can still review the queue, but this session can’t be reopened in the demo.", confirmLabel: "Close session", action: () => setSessionStatus("CLOSED") }); break;
    case "open-display": {
      const displayUrl = new URL(location.href); displayUrl.searchParams.set("view", "display");
      const opened = window.open(`${displayUrl.pathname}${displayUrl.search}`, "_blank");
      if (!opened) showToast("Your browser blocked the new tab. Use Public display from the sidebar.", "error");
      break;
    }
    case "back-dashboard": goToView("dashboard"); break;
    case "get-ticket": issueTicket(); break;
    case "kiosk-help": showToast("If you’re unsure which track to choose, please ask an enrollment staff member."); break;
    case "print-ticket": window.print(); break;
    case "new-student":
      sessionStorage.removeItem("enroll-my-ticket");
      kioskDraft = { grade: "", pathway: "", track: "", documentsChecked: false, orientationComplete: false, step: "prerequisites" };
      kioskTrackFilter = "academic";
      render();
      break;
    case "toggle-speech": toggleSpeech(); break;
    case "fullscreen": toggleFullscreen(); break;
    case "view-history": showToast("All queue actions are recorded in this demo’s activity history."); break;
    case "role-access-info": showToast(cloudMode ? "Staff roles are checked by the Supabase database." : "This preview demonstrates roles only; staff sign-in and access checks are not connected."); break;
    case "staff-sign-out": signOutStaff(); break;
    case "retry-cloud": remoteStatus = "loading"; render(); initializeBackend(); break;
    default: break;
  }
}

function toggleSpeech() {
  if (!("speechSynthesis" in window)) return showToast("Speech announcements aren’t available in this browser.", "error");
  displaySpeechEnabled = !displaySpeechEnabled;
  sessionStorage.setItem("enroll-speech-enabled", String(displaySpeechEnabled));
  if (displaySpeechEnabled) {
    lastSeenAnnouncement = announcementEvent()?.id || "";
    sessionStorage.setItem("enroll-last-announcement", lastSeenAnnouncement);
    showToast("Announcements enabled for new calls.");
  } else {
    window.speechSynthesis.cancel();
    showToast("Announcements turned off.");
  }
  render();
}

function toggleFullscreen() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => showToast("Full screen isn’t available.", "error"));
  else document.exitFullscreen?.();
}

function observeAnnouncement() {
  if (!displaySpeechEnabled || !("speechSynthesis" in window)) return;
  const event = announcementEvent();
  if (!event || event.id === lastSeenAnnouncement || (event.type !== "TICKET_CALLED" && event.type !== "TICKET_RECALLED")) return;
  lastSeenAnnouncement = event.id;
  sessionStorage.setItem("enroll-last-announcement", event.id);
  const utterance = new SpeechSynthesisUtterance(`Ticket ${event.ticketCode}, please proceed to ${state.session.station}.`);
  utterance.rate = 0.93;
  utterance.pitch = 1;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

function refreshExternalState() {
  state = loadState();
  render();
}

dialogConfirm.addEventListener("click", (event) => {
  event.preventDefault();
  dialog.close();
  runConfirmedAction();
});
dialog.addEventListener("close", () => { pendingConfirmAction = null; });
window.addEventListener("popstate", render);
window.addEventListener("storage", (event) => { if (event.key === STORAGE_KEY) refreshExternalState(); });
window.addEventListener("pageshow", () => {
  if (cloudMode && remoteStatus === "ready") refreshRemoteState().catch(() => {});
  else { state = loadState(); render(); }
});
initializeBackend();
