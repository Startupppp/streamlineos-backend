import { mint, req, check, report } from "./harness.mjs";

const ts = Date.now();
const NX = 99999999; // non-existent numeric id

const owner = await mint("owner");
const member = await mint("member");
const sales = await mint("salesRep");

// ---------------------------------------------------------------------------
// AUTH: every protected route with NO token -> 401 (all routes are protected;
// JwtAuthGuard sits at controller level, so it fires before ParseIntPipe).
// ---------------------------------------------------------------------------
check("AUTH GET /deals", await req("GET", "/deals"), 401);
check("AUTH POST /deals", await req("POST", "/deals", { body: { name: "x" } }), 401);
check("AUTH GET /deals/stats", await req("GET", "/deals/stats"), 401);
check("AUTH GET /deals/aging", await req("GET", "/deals/aging"), 401);
check("AUTH GET /deals/forecast", await req("GET", "/deals/forecast"), 401);
check("AUTH GET /deals/win-loss", await req("GET", "/deals/win-loss"), 401);
check("AUTH GET /deals/approval-rules", await req("GET", "/deals/approval-rules"), 401);
check("AUTH POST /deals/approval-rules", await req("POST", "/deals/approval-rules", { body: {} }), 401);
check("AUTH GET /deals/approvals", await req("GET", "/deals/approvals"), 401);
check("AUTH POST /deals/approvals", await req("POST", "/deals/approvals", { body: {} }), 401);
check("AUTH GET /deals/:id", await req("GET", "/deals/1"), 401);
check("AUTH PATCH /deals/:id", await req("PATCH", "/deals/1", { body: {} }), 401);
check("AUTH DELETE /deals/:id", await req("DELETE", "/deals/1"), 401);
check("AUTH POST /deals/:id/clone", await req("POST", "/deals/1/clone"), 401);
check("AUTH GET /deals/:id/activities", await req("GET", "/deals/1/activities"), 401);
check("AUTH POST /deals/:id/activities", await req("POST", "/deals/1/activities", { body: {} }), 401);
check("AUTH PATCH /deals/:id/custom-data", await req("PATCH", "/deals/1/custom-data", { body: {} }), 401);
check("AUTH GET /deals/:id/meetings", await req("GET", "/deals/1/meetings"), 401);
check("AUTH POST /deals/:id/meetings", await req("POST", "/deals/1/meetings", { body: {} }), 401);
check("AUTH PATCH /deals/:id/meetings/:mid", await req("PATCH", "/deals/1/meetings/1", { body: {} }), 401);
check("AUTH DELETE /deals/:id/meetings/:mid", await req("DELETE", "/deals/1/meetings/1"), 401);

// ---------------------------------------------------------------------------
// HAPPY PATH (owner): every GET -> 200. Capture a real deal id for sub-routes.
// ---------------------------------------------------------------------------
const list = await req("GET", "/deals", { token: owner });
check("HAPPY GET /deals (owner)", list, 200);
const realDealId = Array.isArray(list.body) && list.body.length ? list.body[0].id : null;

check("HAPPY GET /deals/stats", await req("GET", "/deals/stats", { token: owner }), 200);
check("HAPPY GET /deals/aging", await req("GET", "/deals/aging", { token: owner }), 200);
check("HAPPY GET /deals/forecast", await req("GET", "/deals/forecast", { token: owner }), 200);
check("HAPPY GET /deals/win-loss", await req("GET", "/deals/win-loss", { token: owner }), 200);
check("HAPPY GET /deals/approval-rules", await req("GET", "/deals/approval-rules", { token: owner }), 200);
check("HAPPY GET /deals/approvals", await req("GET", "/deals/approvals", { token: owner }), 200);
check("HAPPY GET /deals/approvals?status=pending", await req("GET", "/deals/approvals?status=pending&limit=5", { token: owner }), 200);
check("HAPPY GET /deals?stage filter", await req("GET", "/deals?stage=WON&limit=10", { token: owner }), 200);

if (realDealId != null) {
  check("HAPPY GET /deals/:id", await req("GET", `/deals/${realDealId}`, { token: owner }), 200);
  check("HAPPY GET /deals/:id/activities", await req("GET", `/deals/${realDealId}/activities`, { token: owner }), 200);
  check("HAPPY GET /deals/:id/meetings", await req("GET", `/deals/${realDealId}/meetings`, { token: owner }), 200);
} else {
  console.log("  NOTE: no real deals returned — skipped real-id GET sub-routes");
}

// ---------------------------------------------------------------------------
// RBAC NEGATIVE: ability-gated WRITE routes with low-priv token -> 403.
// owner/isOrgOwner can manage:all; salesRep/member carry no permissions.
// (guard blocks before any mutation, so using a real id for DELETE is safe.)
// ---------------------------------------------------------------------------
check("RBAC POST /deals (member)", await req("POST", "/deals", { token: member, body: { name: "RBAC_should_block" } }), 403);
check("RBAC POST /deals (salesRep)", await req("POST", "/deals", { token: sales, body: { name: "RBAC_should_block" } }), 403);
check("RBAC GET /deals read-gated (member)", await req("GET", "/deals", { token: member }), 403);
if (realDealId != null) {
  check("RBAC DELETE /deals/:id (member)", await req("DELETE", `/deals/${realDealId}`, { token: member }), 403);
}
// Approval-rule creation is inline-gated on can(manage,settings); needs a VALID body so
// the handler (not the Zod pipe) is what rejects -> 403 with no row inserted.
check("RBAC POST /deals/approval-rules (member, valid body)", await req("POST", "/deals/approval-rules", { token: member, body: { minValue: "100000" } }), 403);
// Approval resolution is inline-gated the same way (resolve branch of the union).
check("RBAC POST /deals/approvals resolve (member)", await req("POST", "/deals/approvals", { token: member, body: { approvalId: NX, action: "approve" } }), 403);

// ---------------------------------------------------------------------------
// NOT OVER-GATED: auth-only routes with a plain member token -> 200.
// ---------------------------------------------------------------------------
check("OPEN GET /deals/stats (member)", await req("GET", "/deals/stats", { token: member }), 200);
check("OPEN GET /deals/forecast (member)", await req("GET", "/deals/forecast", { token: member }), 200);
check("OPEN GET /deals/approval-rules (member)", await req("GET", "/deals/approval-rules", { token: member }), 200);
check("OPEN GET /deals/approvals (member)", await req("GET", "/deals/approvals", { token: member }), 200);
if (realDealId != null) {
  check("OPEN GET /deals/:id (member)", await req("GET", `/deals/${realDealId}`, { token: member }), 200);
  check("OPEN GET /deals/:id/activities (member)", await req("GET", `/deals/${realDealId}/activities`, { token: member }), 200);
  check("OPEN GET /deals/:id/meetings (member)", await req("GET", `/deals/${realDealId}/meetings`, { token: member }), 200);
}

// ---------------------------------------------------------------------------
// ERROR PATHS
// ---------------------------------------------------------------------------
check("ERR GET /deals/:id non-existent -> 404", await req("GET", `/deals/${NX}`, { token: owner }), 404);
check("ERR GET /deals/:id non-numeric -> 400", await req("GET", "/deals/not-a-number", { token: owner }), 400);
check("ERR POST /deals/:id/clone non-existent -> 404", await req("POST", `/deals/${NX}/clone`, { token: owner }), 404);
check("ERR POST /deals/:id/activities non-existent -> 404", await req("POST", `/deals/${NX}/activities`, { token: owner, body: { type: "note", subject: "x" } }), 404);
check("ERR PATCH /deals/:id/custom-data non-existent -> 404", await req("PATCH", `/deals/${NX}/custom-data`, { token: owner, body: { customData: { a: 1 } } }), 404);
check("ERR PATCH /deals/:id non-existent -> 404", await req("PATCH", `/deals/${NX}`, { token: owner, body: { name: "x" } }), 404);
check("ERR GET /deals/:id/meetings non-existent deal -> 404", await req("GET", `/deals/${NX}/meetings`, { token: owner }), 404);
check("ERR POST /deals/:id/meetings non-existent deal -> 404", await req("POST", `/deals/${NX}/meetings`, { token: owner, body: { title: "x", scheduledAt: new Date().toISOString() } }), 404);
check("ERR PATCH /deals/:id/meetings/:mid non-existent -> 404", await req("PATCH", `/deals/${NX}/meetings/${NX}`, { token: owner, body: { status: "completed" } }), 404);
check("ERR DELETE /deals/:id/meetings/:mid non-existent -> 404", await req("DELETE", `/deals/${NX}/meetings/${NX}`, { token: owner }), 404);
check("ERR POST /deals/approvals request non-existent deal -> 404", await req("POST", "/deals/approvals", { token: owner, body: { dealId: NX, requestedStage: "WON" } }), 404);
check("ERR POST /deals/approvals resolve non-existent -> 404", await req("POST", "/deals/approvals", { token: owner, body: { approvalId: NX, action: "approve" } }), 404);

// Malformed / empty bodies (validation fires before any persistence) -> 400.
check("ERR POST /deals empty body -> 400", await req("POST", "/deals", { token: owner, body: {} }), 400);
check("ERR PATCH /deals/:id bad stage -> 400", await req("PATCH", `/deals/${NX}`, { token: owner, body: { stage: "NOPE" } }), 400);
check("ERR POST /deals/approval-rules empty body -> 400", await req("POST", "/deals/approval-rules", { token: owner, body: {} }), 400);
check("ERR POST /deals/:id/meetings bad body -> 400", await req("POST", `/deals/${NX}/meetings`, { token: owner, body: { title: "" } }), 400);

// ---------------------------------------------------------------------------
// WRITES: create a clearly-marked FN_TEST_ deal, exercise every write
// sub-route against it, then cascade-clean it up (deal_activities + deal_meetings
// FK onDelete:cascade; value=0 keeps approvals from inserting a non-cascading row).
// ---------------------------------------------------------------------------
let testDealId = null;
let clonedId = null;
const created = await req("POST", "/deals", {
  token: owner,
  body: { name: `FN_TEST_deal_${ts}`, value: 0, stage: "LEAD", notes: "functional-test row" },
});
check("WRITE POST /deals create -> 201", created, 201);
testDealId = created.body?.id ?? null;

if (testDealId != null) {
  const fetched = await req("GET", `/deals/${testDealId}`, { token: owner });
  check("WRITE GET created deal -> 200", fetched, 200);
  if (fetched.body?.name !== `FN_TEST_deal_${ts}`) {
    check("WRITE created deal name mismatch", { status: 0 }, 200);
  }

  // PATCH stage (the dedicated stage-change path) -> records a stage_change activity.
  check("WRITE PATCH /deals/:id stage -> 200", await req("PATCH", `/deals/${testDealId}`, { token: owner, body: { stage: "CONTACTED" } }), 200);

  // PATCH custom-data
  check("WRITE PATCH /deals/:id/custom-data -> 200", await req("PATCH", `/deals/${testDealId}/custom-data`, { token: owner, body: { customData: { fnTest: true, ts } } }), 200);

  // POST activity + verify it surfaces in the list
  check("WRITE POST /deals/:id/activities -> 201", await req("POST", `/deals/${testDealId}/activities`, { token: owner, body: { type: "note", subject: "FN_TEST note", notes: "n" } }), 201);
  const acts = await req("GET", `/deals/${testDealId}/activities`, { token: owner });
  check("WRITE GET activities after add -> 200", acts, 200);
  check("WRITE activities non-empty", { status: Array.isArray(acts.body) && acts.body.length > 0 ? 200 : 500 }, 200);

  // auth-only PATCH with a plain member token must succeed (route is not over-gated).
  check("OPEN PATCH /deals/:id (member, auth-only) -> 200", await req("PATCH", `/deals/${testDealId}`, { token: member, body: { notes: "member edit ok" } }), 200);

  // clone -> creates "(Copy)" row at 200; capture for cleanup
  const cloned = await req("POST", `/deals/${testDealId}/clone`, { token: owner });
  check("WRITE POST /deals/:id/clone -> 200", cloned, 200);
  clonedId = cloned.body?.id ?? null;
  if (clonedId != null) {
    check("WRITE GET cloned deal -> 200", await req("GET", `/deals/${clonedId}`, { token: owner }), 200);
  }

  // meetings: create -> list -> update -> delete
  const meeting = await req("POST", `/deals/${testDealId}/meetings`, {
    token: owner,
    body: { title: "FN_TEST meeting", scheduledAt: new Date(ts + 86400000).toISOString(), durationMinutes: 30 },
  });
  check("WRITE POST /deals/:id/meetings -> 201", meeting, 201);
  const meetingId = meeting.body?.id ?? null;
  check("WRITE GET /deals/:id/meetings -> 200", await req("GET", `/deals/${testDealId}/meetings`, { token: owner }), 200);
  if (meetingId != null) {
    check("WRITE PATCH meeting -> 200", await req("PATCH", `/deals/${testDealId}/meetings/${meetingId}`, { token: owner, body: { status: "completed", notes: "done" } }), 200);
    check("WRITE DELETE meeting -> 200", await req("DELETE", `/deals/${testDealId}/meetings/${meetingId}`, { token: owner }), 200);
  }

  // approval request happy path: value=0 means no rule threshold met -> directUpdate (200, no row persisted)
  check("WRITE POST /deals/approvals request (directUpdate) -> 200", await req("POST", "/deals/approvals", { token: owner, body: { dealId: testDealId, requestedStage: "PROPOSAL" } }), 200);

  // cleanup
  if (clonedId != null) {
    check("CLEANUP DELETE cloned -> 200", await req("DELETE", `/deals/${clonedId}`, { token: owner }), 200);
  }
  check("CLEANUP DELETE test deal -> 200", await req("DELETE", `/deals/${testDealId}`, { token: owner }), 200);
  check("CLEANUP verify deal gone -> 404", await req("GET", `/deals/${testDealId}`, { token: owner }), 404);
}

// NOTE: POST /deals/approval-rules success path is intentionally NOT exercised —
// approval rules have no DELETE route, so a created rule cannot be cleaned up.
// Covered instead by RBAC(403) + empty-body(400). Likewise the approval-row
// resolve success path is skipped (would require persisting a pending approval).

process.exit(report("deals") ? 0 : 1);
