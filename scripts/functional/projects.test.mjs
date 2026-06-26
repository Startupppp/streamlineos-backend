import { USERS, mint, req as rawReq, check, report } from "./harness.mjs";

const BAD = 999999999;

// Retry transient infra 5xx (shared dev DB drops connections under parallel load: Postgres ECONNRESET / 08P01); deterministic 4xx and persistent 5xx still surface.
async function req(method, path, opts) {
  let res;
  for (let attempt = 0; attempt < 4; attempt++) {
    res = await rawReq(method, path, opts);
    if (res.status < 500) return res;
    await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
  }
  return res;
}

async function main() {
  const owner = await mint("owner");
  const ceo = await mint("owner", { role: "CEO" });
  const member = await mint("member");
  const salesRep = await mint("salesRep");
  const memberMod = await mint("member", { enabledModules: ["projects"] });

  let projectId = null;
  let ticketId = null;

  // ----------------------------------------------------------------------
  // STEP A — AUTH: every protected route with NO token -> 401
  // (all routes in both modules are JwtAuthGuard-protected; none are @Public)
  // ----------------------------------------------------------------------
  const protectedRoutes = [
    ["GET", "/projects"],
    ["POST", "/projects"],
    ["POST", "/projects/from-deal"],
    ["GET", "/projects/labels"],
    ["POST", "/projects/labels"],
    ["GET", "/projects/resource-allocation"],
    ["GET", "/projects/templates"],
    ["POST", "/projects/templates"],
    ["DELETE", "/projects/templates/1"],
    ["POST", "/projects/templates/1/apply"],
    ["GET", "/projects/roadmap"],
    ["POST", "/projects/roadmap"],
    ["GET", "/projects/roadmap/1"],
    ["GET", "/projects/feedback"],
    ["GET", "/projects/changelog"],
    ["GET", "/projects/1"],
    ["PATCH", "/projects/1"],
    ["DELETE", "/projects/1"],
    ["GET", "/projects/1/members"],
    ["POST", "/projects/1/members"],
    ["GET", "/projects/1/custom-states"],
    ["GET", "/projects/1/labels"],
    ["GET", "/projects/1/tickets"],
    ["POST", "/projects/1/tickets"],
    ["GET", "/projects/1/tickets/2"],
    ["GET", "/projects/1/tickets/2/activity"],
    ["GET", "/projects/1/tickets/2/subtasks"],
    ["GET", "/projects/1/tickets/2/relations"],
    ["GET", "/projects/1/tickets/2/watchers"],
    ["GET", "/projects/1/tickets/2/git-links"],
    ["GET", "/projects/1/analytics"],
    ["GET", "/projects/1/reports/burnup"],
    ["GET", "/projects/1/reports/cfd"],
    ["GET", "/projects/1/reports/critical-path"],
    ["GET", "/projects/1/reports/velocity"],
    ["POST", "/projects/1/reports/snapshot"],
    ["GET", "/projects/1/budget"],
    ["PATCH", "/projects/1/budget"],
    // execution
    ["GET", "/projects/1/sprints"],
    ["POST", "/projects/1/sprints"],
    ["GET", "/projects/1/sprints/1"],
    ["GET", "/projects/1/sprints/1/burndown"],
    ["GET", "/projects/1/cycles"],
    ["POST", "/projects/1/cycles"],
    ["GET", "/projects/1/modules"],
    ["POST", "/projects/1/modules"],
    ["GET", "/projects/1/epics"],
    ["POST", "/projects/1/epics"],
    ["GET", "/projects/1/milestones"],
    ["POST", "/projects/1/milestones"],
    ["GET", "/projects/1/intake"],
    ["POST", "/projects/1/intake"],
    ["GET", "/projects/1/views"],
    ["POST", "/projects/1/views"],
    ["GET", "/projects/1/whiteboards"],
    ["GET", "/projects/1/whiteboards/1"],
    ["GET", "/projects/1/pages"],
    ["POST", "/projects/1/pages"],
    ["GET", "/projects/time-entries"],
    ["GET", "/projects/time-entries/team"],
    ["GET", "/projects/billing-summary"],
    ["GET", "/projects/1/tickets/1/time-entries"],
    ["POST", "/projects/1/tickets/1/time-entries"],
  ];
  for (const [m, p] of protectedRoutes) {
    check(`AUTH 401 ${m} ${p}`, await req(m, p), 401);
  }

  // ----------------------------------------------------------------------
  // STEP B — WRITE setup: create a clearly-marked FN_TEST_ project (owner is
  // a member so member-gated sub-routes resolve). Drives all sub-routes.
  // ----------------------------------------------------------------------
  const created = await req("POST", "/projects", {
    token: owner,
    body: { name: `FN_TEST_project_${Date.now()}`, description: "functional test", memberIds: [USERS.owner.sub] },
  });
  check("WRITE create project (owner)", created, 201);
  projectId = created.body?.id ?? null;

  // RBAC NEGATIVE: low-priv create project -> 403 (@CheckAbility create projects)
  check("RBAC POST /projects member -> 403", await req("POST", "/projects", { token: member, body: { name: "FN_TEST_nope" } }), 403);
  check("RBAC POST /projects salesRep -> 403", await req("POST", "/projects", { token: salesRep, body: { name: "FN_TEST_nope" } }), 403);

  // ERROR: malformed body on create -> 400 (zod, name required) - does not persist
  check("ERR POST /projects empty body -> 400", await req("POST", "/projects", { token: owner, body: {} }), 400);

  if (!projectId) {
    console.error("Could not create FN_TEST_ project; aborting dependent assertions.");
    process.exit(report("projects") ? 0 : 1);
  }
  const P = projectId;

  // ----------------------------------------------------------------------
  // STEP C — HAPPY PATH: owner GET every read route -> 200
  // ----------------------------------------------------------------------
  check("GET /projects", await req("GET", "/projects", { token: owner }), 200);
  check("GET /projects?status=ACTIVE", await req("GET", "/projects?status=ACTIVE&limit=5", { token: owner }), 200);
  check("GET /projects/labels", await req("GET", "/projects/labels", { token: owner }), 200);
  check("GET /projects/templates", await req("GET", "/projects/templates", { token: owner }), 200);
  check("GET /projects/resource-allocation", await req("GET", "/projects/resource-allocation", { token: owner }), 200);
  check("GET /projects/roadmap", await req("GET", "/projects/roadmap", { token: owner }), 200);
  check("GET /projects/feedback", await req("GET", "/projects/feedback", { token: owner }), 200);
  check("GET /projects/changelog", await req("GET", "/projects/changelog", { token: owner }), 200);

  check(`GET /projects/${P}`, await req("GET", `/projects/${P}`, { token: owner }), 200);
  check(`GET /projects/${P}/members`, await req("GET", `/projects/${P}/members`, { token: owner }), 200);
  check(`GET /projects/${P}/custom-states`, await req("GET", `/projects/${P}/custom-states`, { token: owner }), 200);
  check(`GET /projects/${P}/labels`, await req("GET", `/projects/${P}/labels`, { token: owner }), 200);
  check(`GET /projects/${P}/tickets`, await req("GET", `/projects/${P}/tickets`, { token: owner }), 200);
  check(`GET /projects/${P}/budget`, await req("GET", `/projects/${P}/budget`, { token: owner }), 200);
  check(`GET /projects/${P}/analytics`, await req("GET", `/projects/${P}/analytics`, { token: owner }), 200);
  check(`GET /projects/${P}/reports/burnup`, await req("GET", `/projects/${P}/reports/burnup`, { token: owner }), 200);
  check(`GET /projects/${P}/reports/cfd`, await req("GET", `/projects/${P}/reports/cfd`, { token: owner }), 200);
  check(`GET /projects/${P}/reports/critical-path`, await req("GET", `/projects/${P}/reports/critical-path`, { token: owner }), 200);
  check(`GET /projects/${P}/reports/velocity`, await req("GET", `/projects/${P}/reports/velocity`, { token: owner }), 200);

  // execution list GETs (empty arrays on a fresh project = 200)
  check(`GET /projects/${P}/sprints`, await req("GET", `/projects/${P}/sprints`, { token: owner }), 200);
  check(`GET /projects/${P}/cycles`, await req("GET", `/projects/${P}/cycles`, { token: owner }), 200);
  check(`GET /projects/${P}/modules`, await req("GET", `/projects/${P}/modules`, { token: owner }), 200);
  check(`GET /projects/${P}/epics`, await req("GET", `/projects/${P}/epics`, { token: owner }), 200);
  check(`GET /projects/${P}/milestones`, await req("GET", `/projects/${P}/milestones`, { token: owner }), 200);
  check(`GET /projects/${P}/intake`, await req("GET", `/projects/${P}/intake`, { token: owner }), 200);
  check(`GET /projects/${P}/views`, await req("GET", `/projects/${P}/views`, { token: owner }), 200);
  check(`GET /projects/${P}/whiteboards`, await req("GET", `/projects/${P}/whiteboards`, { token: owner }), 200);
  check(`GET /projects/${P}/pages`, await req("GET", `/projects/${P}/pages`, { token: owner }), 200);

  // timesheets read routes
  check("GET /projects/time-entries", await req("GET", "/projects/time-entries", { token: owner }), 200);
  check("GET /projects/time-entries/team (owner=admin)", await req("GET", "/projects/time-entries/team", { token: owner }), 200);
  check("GET /projects/billing-summary", await req("GET", "/projects/billing-summary", { token: owner }), 200);

  // ----------------------------------------------------------------------
  // STEP D — auth-only routes are NOT over-gated: member token -> 200
  // ----------------------------------------------------------------------
  check("AUTHONLY GET /projects member -> 200", await req("GET", "/projects", { token: member }), 200);
  check("AUTHONLY GET /projects/labels member -> 200", await req("GET", "/projects/labels", { token: member }), 200);
  check("AUTHONLY GET /projects/templates member -> 200", await req("GET", "/projects/templates", { token: member }), 200);
  check("AUTHONLY GET /projects/resource-allocation member -> 200", await req("GET", "/projects/resource-allocation", { token: member }), 200);
  check("AUTHONLY GET /projects/time-entries member -> 200", await req("GET", "/projects/time-entries", { token: member }), 200);
  check("AUTHONLY GET /projects/billing-summary member -> 200", await req("GET", "/projects/billing-summary", { token: member }), 200);

  // ----------------------------------------------------------------------
  // STEP E — RBAC NEGATIVE for @CheckAbility / role-string-gated routes
  // ----------------------------------------------------------------------
  // roadmap controller is @CheckAbility-gated (view/manage projects:roadmap)
  check("RBAC GET /projects/roadmap member -> 403", await req("GET", "/projects/roadmap", { token: member }), 403);
  check("RBAC POST /projects/roadmap member -> 403", await req("POST", "/projects/roadmap", { token: member, body: { title: "x" } }), 403);
  check("RBAC POST /projects/feedback member -> 403", await req("POST", "/projects/feedback", { token: member, body: { title: "x" } }), 403);
  check("RBAC POST /projects/changelog member -> 403", await req("POST", "/projects/changelog", { token: member, body: { title: "x" } }), 403);
  check("RBAC GET /projects/changelog member -> 403", await req("GET", "/projects/changelog", { token: member }), 403);

  // sprints create: ModuleGuard + AbilityGuard. member WITHOUT module -> 404 MODULE_DISABLED
  check("RBAC POST sprints member no-module -> 404", await req("POST", `/projects/${P}/sprints`, { token: member, body: {} }), 404);
  // member WITH module but no ability -> 403
  check("RBAC POST sprints member+module -> 403", await req("POST", `/projects/${P}/sprints`, { token: memberMod, body: { name: "x", startDate: "2026-01-01", endDate: "2026-01-10" } }), 403);

  // timesheets admin-gated (inline ability check inside service)
  check("RBAC GET time-entries/team member -> 403", await req("GET", "/projects/time-entries/team", { token: member }), 403);
  check("RBAC PATCH time-entries/:id/approve member -> 403", await req("PATCH", "/projects/time-entries/1/approve", { token: member }), 403);
  check("RBAC PATCH time-entries/:id/reject member -> 403", await req("PATCH", "/projects/time-entries/1/reject", { token: member, body: {} }), 403);

  // ----------------------------------------------------------------------
  // STEP F — ERROR PATHS
  // ----------------------------------------------------------------------
  // non-numeric :id where ParseIntPipe applies -> 400
  check("ERR GET /projects/abc -> 400", await req("GET", "/projects/abc", { token: owner }), 400);
  // non-existent numeric project -> 404 on detail/404-throwing routes
  check("ERR GET /projects/:bad -> 404", await req("GET", `/projects/${BAD}`, { token: owner }), 404);
  check("ERR GET /projects/:bad/budget -> 404", await req("GET", `/projects/${BAD}/budget`, { token: owner }), 404);
  check("ERR GET /projects/:bad/reports/velocity -> 404", await req("GET", `/projects/${BAD}/reports/velocity`, { token: owner }), 404);
  check("ERR GET /projects/:bad/reports/burnup -> 404", await req("GET", `/projects/${BAD}/reports/burnup`, { token: owner }), 404);
  check("ERR GET /projects/:bad/milestones -> 404", await req("GET", `/projects/${BAD}/milestones`, { token: owner }), 404);
  check("ERR GET /projects/:bad/whiteboards -> 404", await req("GET", `/projects/${BAD}/whiteboards`, { token: owner }), 404);
  check("ERR GET roadmap/:bad -> 404", await req("GET", `/projects/roadmap/${BAD}`, { token: owner }), 404);
  check("ERR GET feedback/:bad -> 404", await req("GET", `/projects/feedback/${BAD}`, { token: owner }), 404);
  check("ERR GET changelog/:bad -> 404", await req("GET", `/projects/changelog/${BAD}`, { token: owner }), 404);
  check("ERR GET sprints/:bad -> 404", await req("GET", `/projects/${P}/sprints/${BAD}`, { token: owner }), 404);
  check("ERR GET sprints/:bad/burndown -> 404", await req("GET", `/projects/${P}/sprints/${BAD}/burndown`, { token: owner }), 404);
  check("ERR GET tickets/:bad -> 404", await req("GET", `/projects/${P}/tickets/${BAD}`, { token: owner }), 404);
  check("ERR GET whiteboards/:bad -> 404", await req("GET", `/projects/${P}/whiteboards/${BAD}`, { token: owner }), 404);
  // from-deal with non-existent deal -> 404
  check("ERR POST /projects/from-deal bad deal -> 404", await req("POST", "/projects/from-deal", { token: owner, body: { dealId: BAD, name: "FN_TEST_fd" } }), 404);
  // malformed PATCH budget body -> 400 (budget required number)
  check("ERR PATCH budget bad body -> 400", await req("PATCH", `/projects/${P}/budget`, { token: owner, body: { budget: "notnum" } }), 400);

  // ----------------------------------------------------------------------
  // STEP G — WRITES (non-destructive; create FN_TEST_ -> verify -> delete)
  // ----------------------------------------------------------------------
  // Members: add salesRep to FN_TEST_ project, then remove (contained in throwaway project)
  check(`WRITE add member`, await req("POST", `/projects/${P}/members`, { token: owner, body: { userId: USERS.salesRep.sub, role: "CONTRIBUTOR" } }), 201);
  check(`WRITE remove member`, await req("DELETE", `/projects/${P}/members`, { token: owner, body: { userId: USERS.salesRep.sub } }), 200);

  // Ticket: create -> GET sub-routes -> sub-resource writes -> delete (cascade cleans children)
  const tk = await req("POST", `/projects/${P}/tickets`, { token: owner, body: { title: "FN_TEST_ticket", type: "TASK" } });
  check("WRITE create ticket", tk, 201);
  ticketId = tk.body?.id ?? null;
  if (ticketId) {
    const T = ticketId;
    check(`GET ticket ${T}`, await req("GET", `/projects/${P}/tickets/${T}`, { token: owner }), 200);
    check(`GET ticket ${T} activity`, await req("GET", `/projects/${P}/tickets/${T}/activity`, { token: owner }), 200);
    check(`GET ticket ${T} subtasks`, await req("GET", `/projects/${P}/tickets/${T}/subtasks`, { token: owner }), 200);
    check(`GET ticket ${T} relations`, await req("GET", `/projects/${P}/tickets/${T}/relations`, { token: owner }), 200);
    check(`GET ticket ${T} watchers`, await req("GET", `/projects/${P}/tickets/${T}/watchers`, { token: owner }), 200);
    check(`GET ticket ${T} git-links`, await req("GET", `/projects/${P}/tickets/${T}/git-links`, { token: owner }), 200);
    check(`GET ticket ${T} time-entries`, await req("GET", `/projects/${P}/tickets/${T}/time-entries`, { token: owner }), 200);
    // PATCH ticket
    check(`PATCH ticket ${T}`, await req("PATCH", `/projects/${P}/tickets/${T}`, { token: owner, body: { priority: "HIGH" } }), 200);
    // reorder + bulk update (owner is a project member)
    check(`PATCH tickets/reorder`, await req("PATCH", `/projects/${P}/tickets/reorder`, { token: owner, body: { items: [{ id: T, status: "TODO", order: 1 }] } }), 200);
    check(`POST tickets/bulk`, await req("POST", `/projects/${P}/tickets/bulk`, { token: owner, body: { ticketIds: [T], priority: "LOW" } }), 200);
    // comment / watcher / attachment (cascade-deleted with ticket)
    check(`POST comment`, await req("POST", `/projects/${P}/tickets/${T}/comments`, { token: owner, body: { content: "FN_TEST_comment" } }), 201);
    check(`POST watcher`, await req("POST", `/projects/${P}/tickets/${T}/watchers`, { token: owner, body: {} }), 201);
    check(`DELETE watcher`, await req("DELETE", `/projects/${P}/tickets/${T}/watchers`, { token: owner }), 200);
    check(`POST attachment`, await req("POST", `/projects/${P}/tickets/${T}/attachments`, { token: owner, body: { fileName: "FN_TEST.txt", fileUrl: "https://x/FN_TEST.txt", fileSize: 1, mimeType: "text/plain" } }), 201);
    // relation needs a second ticket
    const tk2 = await req("POST", `/projects/${P}/tickets`, { token: owner, body: { title: "FN_TEST_ticket2", type: "TASK" } });
    check("WRITE create ticket2", tk2, 201);
    const T2 = tk2.body?.id ?? null;
    if (T2) {
      check(`POST relation`, await req("POST", `/projects/${P}/tickets/${T}/relations`, { token: owner, body: { relatedTicketId: T2, relationType: "relates_to" } }), 201);
      check(`DELETE relation`, await req("DELETE", `/projects/${P}/tickets/${T}/relations?relatedId=${T2}`, { token: owner }), 200);
      check(`WRITE delete ticket2 ${T2}`, await req("DELETE", `/projects/${P}/tickets/${T2}?force=true`, { token: owner }), 200);
    }
    // time entries: log -> approve; log -> reject (owner is admin). Cascade-deleted with ticket.
    const teA = await req("POST", `/projects/${P}/tickets/${T}/time-entries`, { token: owner, body: { date: "2026-01-15", hours: 1, description: "FN_TEST_time_a" } });
    check(`WRITE log time A`, teA, 201);
    if (teA.body?.id) check(`PATCH approve entry`, await req("PATCH", `/projects/time-entries/${teA.body.id}/approve`, { token: owner }), 200);
    const teB = await req("POST", `/projects/${P}/tickets/${T}/time-entries`, { token: owner, body: { date: "2026-01-16", hours: 2, description: "FN_TEST_time_b" } });
    check(`WRITE log time B`, teB, 201);
    if (teB.body?.id) {
      check(`PATCH update entry`, await req("PATCH", `/projects/time-entries/${teB.body.id}`, { token: owner, body: { hours: 3 } }), 200);
      check(`PATCH reject entry`, await req("PATCH", `/projects/time-entries/${teB.body.id}/reject`, { token: owner, body: { reason: "FN_TEST" } }), 200);
    }
    // log -> delete a pending entry (DELETE time-entries happy path)
    const teC = await req("POST", `/projects/${P}/tickets/${T}/time-entries`, { token: owner, body: { date: "2026-01-17", hours: 1 } });
    check(`WRITE log time C`, teC, 201);
    if (teC.body?.id) check(`DELETE time entry ${teC.body.id}`, await req("DELETE", `/projects/time-entries/${teC.body.id}`, { token: owner }), 200);
    // cleanup ticket (cascade deletes comments, attachments, watchers, timesheets)
    check(`WRITE delete ticket ${T}`, await req("DELETE", `/projects/${P}/tickets/${T}?force=true`, { token: owner }), 200);
  }

  // Roadmap: create -> get -> delete (owner has manage all)
  const rm = await req("POST", "/projects/roadmap", { token: owner, body: { title: "FN_TEST_roadmap" } });
  check("WRITE create roadmap", rm, 201);
  const rmId = rm.body?.id ?? null;
  if (rmId) {
    check(`GET roadmap ${rmId}`, await req("GET", `/projects/roadmap/${rmId}`, { token: owner }), 200);
    check(`WRITE delete roadmap ${rmId}`, await req("DELETE", `/projects/roadmap/${rmId}`, { token: owner }), 200);
  }

  // Feedback: create -> delete
  const fb = await req("POST", "/projects/feedback", { token: owner, body: { title: "FN_TEST_feedback" } });
  check("WRITE create feedback", fb, 201);
  const fbId = fb.body?.id ?? null;
  if (fbId) check(`WRITE delete feedback ${fbId}`, await req("DELETE", `/projects/feedback/${fbId}`, { token: owner }), 200);

  // Changelog: create -> delete
  const cl = await req("POST", "/projects/changelog", { token: owner, body: { title: "FN_TEST_changelog" } });
  check("WRITE create changelog", cl, 201);
  const clId = cl.body?.id ?? null;
  if (clId) check(`WRITE delete changelog ${clId}`, await req("DELETE", `/projects/changelog/${clId}`, { token: owner }), 200);

  // Template: create -> delete
  const tmpl = await req("POST", "/projects/templates", { token: owner, body: { name: "FN_TEST_template", tickets: [] } });
  check("WRITE create template", tmpl, 201);
  const tmplId = tmpl.body?.id ?? null;
  if (tmplId) check(`WRITE delete template ${tmplId}`, await req("DELETE", `/projects/templates/${tmplId}`, { token: owner }), 200);

  // Cycle: create -> patch -> delete (per project)
  const cy = await req("POST", `/projects/${P}/cycles`, { token: owner, body: { name: "FN_TEST_cycle", startDate: "2026-03-01", endDate: "2026-03-15" } });
  check("WRITE create cycle", cy, 201);
  const cyId = cy.body?.id ?? null;
  if (cyId) {
    check(`PATCH cycle ${cyId}`, await req("PATCH", `/projects/${P}/cycles/${cyId}`, { token: owner, body: { description: "FN_TEST_upd" } }), 200);
    check(`WRITE delete cycle ${cyId}`, await req("DELETE", `/projects/${P}/cycles/${cyId}`, { token: owner }), 200);
  }

  // Module: create -> patch -> delete
  const md = await req("POST", `/projects/${P}/modules`, { token: owner, body: { name: "FN_TEST_module" } });
  check("WRITE create module", md, 201);
  const mdId = md.body?.id ?? null;
  if (mdId) {
    check(`PATCH module ${mdId}`, await req("PATCH", `/projects/${P}/modules/${mdId}`, { token: owner, body: { status: "planned" } }), 200);
    check(`WRITE delete module ${mdId}`, await req("DELETE", `/projects/${P}/modules/${mdId}`, { token: owner }), 200);
  }

  // Milestone: create -> patch -> delete
  const ms = await req("POST", `/projects/${P}/milestones`, { token: owner, body: { name: "FN_TEST_milestone", targetDate: "2026-04-01" } });
  check("WRITE create milestone", ms, 201);
  const msId = ms.body?.id ?? null;
  if (msId) {
    check(`PATCH milestone ${msId}`, await req("PATCH", `/projects/${P}/milestones/${msId}`, { token: owner, body: { status: "ACHIEVED" } }), 200);
    check(`WRITE delete milestone ${msId}`, await req("DELETE", `/projects/${P}/milestones/${msId}`, { token: owner }), 200);
  }

  // NOTE: POST /projects/:id/intake, POST :id/custom-states and POST labels are
  // intentionally NOT exercised as writes: they have no DELETE endpoint and are
  // not cascaded by deleteProject, so a FN_TEST_ row could not be cleaned up.

  // View: create -> patch -> delete
  const vw = await req("POST", `/projects/${P}/views`, { token: owner, body: { name: "FN_TEST_view" } });
  check("WRITE create view", vw, 201);
  const vwId = vw.body?.id ?? null;
  if (vwId) {
    check(`PATCH view ${vwId}`, await req("PATCH", `/projects/${P}/views/${vwId}`, { token: owner, body: { isPinned: true } }), 200);
    check(`WRITE delete view ${vwId}`, await req("DELETE", `/projects/${P}/views/${vwId}`, { token: owner }), 200);
  }

  // Whiteboard: create -> get -> patch -> delete
  const wb = await req("POST", `/projects/${P}/whiteboards`, { token: owner, body: { name: "FN_TEST_wb" } });
  check("WRITE create whiteboard", wb, 201);
  const wbId = wb.body?.id ?? null;
  if (wbId) {
    check(`GET whiteboard ${wbId}`, await req("GET", `/projects/${P}/whiteboards/${wbId}`, { token: owner }), 200);
    check(`PATCH whiteboard ${wbId}`, await req("PATCH", `/projects/${P}/whiteboards/${wbId}`, { token: owner, body: { name: "FN_TEST_wb2" } }), 200);
    check(`WRITE delete whiteboard ${wbId}`, await req("DELETE", `/projects/${P}/whiteboards/${wbId}`, { token: owner }), 200);
  }

  // Page: create -> patch -> delete
  const pg = await req("POST", `/projects/${P}/pages`, { token: owner, body: { title: "FN_TEST_page" } });
  check("WRITE create page", pg, 201);
  const pgId = pg.body?.id ?? null;
  if (pgId) {
    check(`PATCH page ${pgId}`, await req("PATCH", `/projects/${P}/pages/${pgId}`, { token: owner, body: { title: "FN_TEST_page2" } }), 200);
    check(`WRITE delete page ${pgId}`, await req("DELETE", `/projects/${P}/pages/${pgId}`, { token: owner }), 200);
  }

  // Epic: create (no delete endpoint -> remove as a ticket via ticket DELETE)
  const ep = await req("POST", `/projects/${P}/epics`, { token: owner, body: { title: "FN_TEST_epic" } });
  check("WRITE create epic", ep, 201);
  const epId = ep.body?.id ?? null;
  if (epId) check(`WRITE delete epic-as-ticket ${epId}`, await req("DELETE", `/projects/${P}/tickets/${epId}?force=true`, { token: owner }), 200);

  // Sprint: create (no delete endpoint). Created under FN_TEST_ project that we
  // delete at the end (deleteProject cascades sprints), so it's still cleaned up.
  const sp = await req("POST", `/projects/${P}/sprints`, { token: await mint("owner", { enabledModules: ["projects"] }), body: { name: "FN_TEST_sprint", startDate: "2026-05-01", endDate: "2026-05-14" } });
  check("WRITE create sprint", sp, 201);

  // Snapshot (POST 200, idempotent upsert, scoped to FN_TEST_ project)
  check(`POST reports/snapshot`, await req("POST", `/projects/${P}/reports/snapshot`, { token: owner }), 200);

  // PATCH project (budget + update)
  check(`PATCH /projects/${P}`, await req("PATCH", `/projects/${P}`, { token: owner, body: { description: "FN_TEST_updated" } }), 200);
  check(`PATCH /projects/${P}/budget`, await req("PATCH", `/projects/${P}/budget`, { token: owner, body: { budget: 1000 } }), 200);

  // RBAC DENY (genuine): non-privileged roles still cannot delete -> 403
  // (gate runs before any DB read, so P is not touched by these attempts)
  check(`RBAC DELETE project MEMBER -> 403`, await req("DELETE", `/projects/${P}`, { token: member }), 403);
  check(`RBAC DELETE project salesRep -> 403`, await req("DELETE", `/projects/${P}`, { token: salesRep }), 403);

  // CORRECTED: org OWNER is privileged (isOrgOwner) -> deleteProject now allows it
  // via hasRoleOrPrivileged (previously 403 under the role==="CEO"-only gate).
  const delAsOwner = await req("DELETE", `/projects/${P}`, { token: owner });
  check(`DELETE project as org OWNER (isOrgOwner) -> 200`, delAsOwner, 200);
  check(`verify owner-deleted project gone -> 404`, await req("GET", `/projects/${P}`, { token: owner }), 404);

  // ----------------------------------------------------------------------
  // STEP H — role=CEO token also deletes (separate throwaway project)
  // ----------------------------------------------------------------------
  const p2 = await req("POST", "/projects", { token: owner, body: { name: `FN_TEST_ceo_del_${Date.now()}`, memberIds: [USERS.owner.sub] } });
  check("WRITE create project for CEO-delete", p2, 201);
  const P2 = p2.body?.id ?? null;
  if (P2) {
    check(`CLEANUP delete FN_TEST_ project as CEO -> 200`, await req("DELETE", `/projects/${P2}`, { token: ceo }), 200);
    check(`CLEANUP verify CEO-deleted project gone -> 404`, await req("GET", `/projects/${P2}`, { token: owner }), 404);
  }

  process.exit(report("projects") ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
