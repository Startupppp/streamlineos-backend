import { mint, req, check, report, USERS } from "./harness.mjs";

const owner = await mint("owner");
const hrManager = await mint("hrManager");
const member = await mint("member");
const salesRep = await mint("salesRep");

const ownerId = USERS.owner.sub;
const memberId = USERS.member.sub;
const FAKE_UUID = "00000000-0000-0000-0000-000000000000";

const routes = new Set();
const mark = (m, p) => routes.add(`${m} ${p}`);
async function hit(label, m, p, opts, want, tmpl) {
  mark(m, tmpl ?? p);
  return check(label, await req(m, p, opts), want);
}

// ---------------------------------------------------------------------------
// Gather real ids to drive detail/sub-routes
// ---------------------------------------------------------------------------
const dir = await req("GET", "/hr/directory", { token: owner });
const dirList = Array.isArray(dir.body) ? dir.body : [];
const empId = dirList[0]?.id ?? ownerId;
const deptId = dirList.find((d) => d?.department?.id)?.department?.id ?? null;

// ---------------------------------------------------------------------------
// AUTH: protected routes with NO token -> 401 (one per controller surface)
// ---------------------------------------------------------------------------
const authProbe = [
  ["GET", "/hr/asset-returns"],
  ["GET", "/hr/devices"],
  ["GET", "/hr/background-verification"],
  ["GET", "/hr/employees"],
  ["GET", "/hr/directory"],
  ["GET", "/hr/org-chart"],
  ["GET", "/hr/team-events"],
  ["GET", "/hr/documents"],
  ["GET", "/hr/compliance"],
  ["GET", "/hr/rich-documents"],
  ["GET", "/hr/my-goals"],
  ["GET", "/hr/feedback"],
  ["GET", "/hr/surveys"],
  ["GET", "/hr/performance/goals"],
  ["GET", "/hr/performance/one-on-ones"],
  ["GET", "/hr/performance/pip"],
];
for (const [m, p] of authProbe) await hit(`AUTH ${m} ${p} no-token`, m, p, {}, 401);

// ---------------------------------------------------------------------------
// HAPPY PATH: owner -> every GET list/aggregate -> 200
// ---------------------------------------------------------------------------
const ownerGets = [
  "/hr/asset-returns",
  "/hr/devices",
  "/hr/background-verification",
  "/hr/employees",
  "/hr/employees/stats",
  "/hr/employees/anniversary-feed",
  "/hr/employees/availability",
  ["/hr/employees/check-email?email=fn-test@example.com", "/hr/employees/check-email"],
  ["/hr/employees/find-expert?skill=javascript", "/hr/employees/find-expert"],
  "/hr/employees/skills-matrix",
  "/hr/employees/projects",
  "/hr/employees/tickets",
  "/hr/directory",
  "/hr/celebrations",
  "/hr/org-chart",
  "/hr/headcount",
  ["/hr/headcount?groupBy=role", "/hr/headcount"],
  "/hr/team-events",
  "/hr/documents",
  "/hr/documents/stats",
  "/hr/document-expiry",
  "/hr/compliance",
  "/hr/compliance/statutory",
  "/hr/rich-documents",
  "/hr/my-goals",
  "/hr/feedback",
  "/hr/assessments",
  "/hr/recognition",
  "/hr/enps",
  "/hr/surveys",
  "/hr/performance/goals",
  "/hr/performance/one-on-ones",
  ["/hr/performance/one-on-ones?upcoming=true", "/hr/performance/one-on-ones"],
  "/hr/performance/pip",
];
for (const g of ownerGets) {
  const p = Array.isArray(g) ? g[0] : g;
  const t = Array.isArray(g) ? g[1] : g;
  await hit(`GET owner ${p}`, "GET", p, { token: owner }, 200, t);
}

// Employee detail / sub-routes (owner)
await hit(`GET owner reports-to-me`, "GET", `/hr/employees/${empId}/reports-to-me`, { token: owner }, 200, "/hr/employees/:id/reports-to-me");
await hit(`GET owner manager-scorecard`, "GET", `/hr/employees/${empId}/manager-scorecard`, { token: owner }, 200, "/hr/employees/:id/manager-scorecard");
// profile-pdf is gated to role-strings CEO/HR/ADMIN/HR_MANAGER -> hrManager allowed, OWNER excluded by design
await hit(`GET hrManager profile-pdf`, "GET", `/hr/employees/${empId}/profile-pdf`, { token: hrManager }, 200, "/hr/employees/:id/profile-pdf");
await hit(`RBAC owner profile-pdf excluded-by-role-list`, "GET", `/hr/employees/${empId}/profile-pdf`, { token: owner }, 403, "/hr/employees/:id/profile-pdf");

// teams detail (owner) if we have a real department id
if (deptId != null) {
  await hit(`GET owner team`, "GET", `/hr/teams/${deptId}`, { token: owner }, 200, "/hr/teams/:id");
}

// ---------------------------------------------------------------------------
// RBAC NEGATIVE: low-priv tokens (member/salesRep) on gated routes -> 403
// ---------------------------------------------------------------------------
// CheckAbility guard-gated (deny before body parsing)
await hit(`RBAC member GET /hr/employees`, "GET", "/hr/employees", { token: member }, 403);
await hit(`RBAC salesRep GET /hr/employees`, "GET", "/hr/employees", { token: salesRep }, 403);
await hit(`RBAC member GET /hr/headcount`, "GET", "/hr/headcount", { token: member }, 403);
await hit(`RBAC member GET /hr/compliance/statutory`, "GET", "/hr/compliance/statutory", { token: member }, 403);
await hit(`RBAC member POST /hr/asset-returns`, "POST", "/hr/asset-returns", { token: member }, 403);
await hit(`RBAC member PATCH /hr/asset-returns/:id`, "PATCH", "/hr/asset-returns/999999", { token: member }, 403, "/hr/asset-returns/:id");
await hit(`RBAC member POST /hr/feedback`, "POST", "/hr/feedback", { token: member }, 403);

// inline canManage*/userCan checks (run after Zod pipe) -> send a VALID body so the 403 (not 400) is exercised; throws before any DB write
const validDevice = { userId: ownerId, deviceType: "Laptop", deviceName: "FN_TEST_RbacLaptop", serialNumber: `FN-RBAC-${Date.now()}`, brand: "FNBrand", model: "FNModel" };
await hit(`RBAC member POST /hr/devices`, "POST", "/hr/devices", { token: member, body: validDevice }, 403);
await hit(`RBAC member POST /hr/background-verification`, "POST", "/hr/background-verification", { token: member, body: { userId: ownerId, type: "IDENTITY" } }, 403);
await hit(`RBAC member PATCH /hr/background-verification`, "PATCH", "/hr/background-verification", { token: member, body: { id: 999999, status: "PASSED" } }, 403);
await hit(`RBAC member POST /hr/team-events`, "POST", "/hr/team-events", { token: member, body: { title: "FN_TEST_Event", date: "2030-01-01" } }, 403);
await hit(`RBAC member POST /hr/compliance`, "POST", "/hr/compliance", { token: member, body: { documentId: 1, userIds: [ownerId] } }, 403);
await hit(`RBAC member GET /hr/enps`, "GET", "/hr/enps", { token: member }, 403);
await hit(`RBAC member POST /hr/assessments (no x-action)`, "POST", "/hr/assessments", { token: member, body: {} }, 403);
await hit(`RBAC member POST /hr/surveys (no x-action)`, "POST", "/hr/surveys", { token: member, body: {} }, 403);
await hit(`RBAC member POST /hr/performance/goals`, "POST", "/hr/performance/goals", { token: member, body: { userId: ownerId, title: "FN_TEST_Goal", startDate: "2025-01-01", endDate: "2025-12-31" } }, 403);
await hit(`RBAC member PATCH /hr/performance/goals`, "PATCH", "/hr/performance/goals", { token: member, body: { goalId: 999999 } }, 403);
await hit(`RBAC member POST /hr/performance/pip`, "POST", "/hr/performance/pip", { token: member, body: { userId: ownerId, reason: "x", objectives: [{ objective: "a", metric: "b", deadline: "2030-01-01" }], startDate: "2030-01-01", endDate: "2030-06-01" } }, 403);
await hit(`RBAC member PATCH /hr/performance/pip/:id`, "PATCH", "/hr/performance/pip/999999", { token: member, body: { status: "COMPLETED" } }, 403, "/hr/performance/pip/:id");
await hit(`RBAC member PATCH /hr/surveys/:id`, "PATCH", "/hr/surveys/999999", { token: member, body: { status: "ACTIVE" } }, 403, "/hr/surveys/:id");
await hit(`RBAC member PATCH /hr/performance/cycles/:id`, "PATCH", "/hr/performance/cycles/999999", { token: member, body: { name: "x" } }, 403, "/hr/performance/cycles/:id");
await hit(`RBAC member DELETE /hr/performance/cycles/:id`, "DELETE", "/hr/performance/cycles/999999", { token: member }, 403, "/hr/performance/cycles/:id");
// listGoals: requesting another user's goals as non-admin -> 403
await hit(`RBAC member GET /hr/performance/goals?userId=other`, "GET", `/hr/performance/goals?userId=${ownerId}`, { token: member }, 403, "/hr/performance/goals");
// manager-scorecard: member viewing someone else's scorecard -> 403
await hit(`RBAC member manager-scorecard other`, "GET", `/hr/employees/${ownerId}/manager-scorecard`, { token: member }, 403, "/hr/employees/:id/manager-scorecard");

// ---------------------------------------------------------------------------
// NOT over-gated: auth-only routes must accept a plain member -> 200
// ---------------------------------------------------------------------------
const memberOk = [
  "/hr/devices",
  "/hr/background-verification",
  "/hr/directory",
  "/hr/celebrations",
  "/hr/org-chart",
  "/hr/team-events",
  "/hr/employees/stats",
  "/hr/employees/skills-matrix",
  "/hr/employees/anniversary-feed",
  "/hr/documents",
  "/hr/documents/stats",
  "/hr/document-expiry",
  "/hr/compliance",
  "/hr/rich-documents",
  "/hr/my-goals",
  "/hr/feedback",
  "/hr/assessments",
  "/hr/recognition",
  "/hr/surveys",
  "/hr/performance/one-on-ones",
  "/hr/performance/pip",
];
for (const p of memberOk) await hit(`NOT-over-gated member ${p}`, "GET", p, { token: member }, 200);
// member viewing own manager-scorecard: gate passes (200, or 404 if member is not an org member) — must NOT be 403
await hit(`NOT-over-gated member self scorecard`, "GET", `/hr/employees/${memberId}/manager-scorecard`, { token: member }, [200, 404], "/hr/employees/:id/manager-scorecard");

// ---------------------------------------------------------------------------
// ERROR PATHS: 404 (missing id), 400 (non-numeric ParseIntPipe / missing required query)
// ---------------------------------------------------------------------------
await hit(`ERR teams missing`, "GET", "/hr/teams/999999", { token: owner }, 404, "/hr/teams/:id");
await hit(`ERR teams non-numeric`, "GET", "/hr/teams/not-a-number", { token: owner }, 400, "/hr/teams/:id");
await hit(`ERR rich-doc missing`, "GET", "/hr/rich-documents/999999", { token: owner }, 404, "/hr/rich-documents/:id");
await hit(`ERR rich-doc non-numeric`, "GET", "/hr/rich-documents/abc", { token: owner }, 400, "/hr/rich-documents/:id");
await hit(`ERR review missing`, "GET", "/hr/performance/reviews/999999", { token: owner }, 404, "/hr/performance/reviews/:id");
await hit(`ERR review non-numeric`, "GET", "/hr/performance/reviews/abc", { token: owner }, 400, "/hr/performance/reviews/:id");
await hit(`ERR cycle missing`, "GET", "/hr/performance/cycles/999999", { token: owner }, 404, "/hr/performance/cycles/:id");
await hit(`ERR cycle non-numeric`, "GET", "/hr/performance/cycles/abc", { token: owner }, 400, "/hr/performance/cycles/:id");
await hit(`ERR reports-to-me missing employee`, "GET", `/hr/employees/${FAKE_UUID}/reports-to-me`, { token: owner }, 404, "/hr/employees/:id/reports-to-me");
await hit(`ERR profile-pdf missing employee`, "GET", `/hr/employees/${FAKE_UUID}/profile-pdf`, { token: hrManager }, 404, "/hr/employees/:id/profile-pdf");
await hit(`ERR check-email missing param`, "GET", "/hr/employees/check-email", { token: owner }, 400, "/hr/employees/check-email");
await hit(`ERR key-results missing goalId`, "GET", "/hr/performance/key-results", { token: owner }, 400, "/hr/performance/key-results");
await hit(`ERR key-results missing goal`, "GET", "/hr/performance/key-results?goalId=999999", { token: owner }, 404, "/hr/performance/key-results");

// Missing-id behaviour on update/delete handlers (owner) — should 404, never 500
await hit(`ERR PATCH asset-return missing`, "PATCH", "/hr/asset-returns/999999", { token: owner, body: { status: "RETURNED" } }, 404, "/hr/asset-returns/:id");
await hit(`ERR PATCH device missing`, "PATCH", "/hr/devices/999999", { token: owner, body: { status: "INACTIVE" } }, 404, "/hr/devices/:id");
await hit(`ERR DELETE device missing`, "DELETE", "/hr/devices/999999", { token: owner }, 404, "/hr/devices/:id");
await hit(`ERR PATCH feedback missing`, "PATCH", "/hr/feedback/999999", { token: owner, body: { ratings: [{ category: "Quality", score: 3 }] } }, 404, "/hr/feedback/:id");
await hit(`ERR PATCH one-on-one missing`, "PATCH", "/hr/performance/one-on-ones/999999", { token: owner, body: { status: "COMPLETED" } }, 404, "/hr/performance/one-on-ones/:id");
await hit(`ERR PATCH review missing`, "PATCH", "/hr/performance/reviews/999999", { token: owner, body: { status: "DRAFT" } }, 404, "/hr/performance/reviews/:id");
await hit(`ERR DELETE review missing`, "DELETE", "/hr/performance/reviews/999999", { token: owner }, 404, "/hr/performance/reviews/:id");
await hit(`ERR PATCH cycle missing`, "PATCH", "/hr/performance/cycles/999999", { token: owner, body: { name: "FN_TEST_NoCycle" } }, 404, "/hr/performance/cycles/:id");
await hit(`ERR join missing event`, "POST", "/hr/team-events/999999", { token: owner }, 404, "/hr/team-events/:id");
await hit(`ERR PATCH goal item non-numeric`, "PATCH", "/hr/performance/goals/abc", { token: owner, body: { progress: 10 } }, 400, "/hr/performance/goals/:id");
await hit(`ERR DELETE goal non-numeric`, "DELETE", "/hr/performance/goals/abc", { token: owner }, 400, "/hr/performance/goals/:id");

// ---------------------------------------------------------------------------
// MALFORMED / EMPTY body -> 400 (non-persisting; Zod rejects before any DB write)
// ---------------------------------------------------------------------------
await hit(`MAL POST /hr/devices {}`, "POST", "/hr/devices", { token: owner, body: {} }, 400);
await hit(`MAL POST /hr/rich-documents {}`, "POST", "/hr/rich-documents", { token: owner, body: {} }, 400);
await hit(`MAL POST /hr/background-verification {}`, "POST", "/hr/background-verification", { token: owner, body: {} }, 400);
await hit(`MAL PATCH /hr/background-verification {}`, "PATCH", "/hr/background-verification", { token: owner, body: {} }, 400);
await hit(`MAL POST /hr/feedback {}`, "POST", "/hr/feedback", { token: owner, body: {} }, 400);
await hit(`MAL POST /hr/recognition {}`, "POST", "/hr/recognition", { token: owner, body: {} }, 400);
await hit(`MAL POST /hr/enps {}`, "POST", "/hr/enps", { token: owner, body: {} }, 400);
await hit(`MAL POST /hr/assessments owner {}`, "POST", "/hr/assessments", { token: owner, body: {} }, 400);
await hit(`MAL POST /hr/surveys owner {}`, "POST", "/hr/surveys", { token: owner, body: {} }, 400);
await hit(`MAL PATCH /hr/compliance {}`, "PATCH", "/hr/compliance", { token: owner, body: {} }, 400);
await hit(`MAL POST /hr/performance/goals owner {}`, "POST", "/hr/performance/goals", { token: owner, body: {} }, 400);
await hit(`MAL PATCH /hr/performance/goals owner {}`, "PATCH", "/hr/performance/goals", { token: owner, body: {} }, 400);
await hit(`MAL POST /hr/performance/key-results owner {}`, "POST", "/hr/performance/key-results", { token: owner, body: {} }, 400);
await hit(`MAL PATCH /hr/performance/key-results owner {}`, "PATCH", "/hr/performance/key-results", { token: owner, body: {} }, 400);
await hit(`MAL POST /hr/performance/one-on-ones owner {}`, "POST", "/hr/performance/one-on-ones", { token: owner, body: {} }, 400);
await hit(`MAL POST /hr/performance/pip owner {}`, "POST", "/hr/performance/pip", { token: owner, body: {} }, 400);

// ---------------------------------------------------------------------------
// WRITES: reversible only — create FN_TEST_ row, verify via GET, then delete
// ---------------------------------------------------------------------------

// (1) Device: POST -> GET list -> PATCH -> DELETE
const devBody = { userId: ownerId, deviceType: "Laptop", deviceName: "FN_TEST_Laptop", serialNumber: `FN-TEST-${Date.now()}`, brand: "FNBrand", model: "FNModel" };
const devCreate = await req("POST", "/hr/devices", { token: owner, body: devBody });
mark("POST", "/hr/devices");
check("WRITE POST /hr/devices 201", devCreate, 201);
const devId = devCreate.body?.id;
if (devId) {
  const devList = await req("GET", "/hr/devices", { token: owner });
  const present = Array.isArray(devList.body) && devList.body.some((d) => d.id === devId);
  check("WRITE device present in list", { status: present ? 200 : 404 }, 200);
  await hit("WRITE PATCH /hr/devices/:id", "PATCH", `/hr/devices/${devId}`, { token: owner, body: { notes: "FN_TEST_updated" } }, 200, "/hr/devices/:id");
  await hit("WRITE DELETE /hr/devices/:id", "DELETE", `/hr/devices/${devId}`, { token: owner }, 200, "/hr/devices/:id");
  const devGone = await req("GET", "/hr/devices", { token: owner });
  const stillThere = Array.isArray(devGone.body) && devGone.body.some((d) => d.id === devId);
  check("WRITE device removed after delete", { status: stillThere ? 500 : 200 }, 200);
}

// (2) Rich document: POST -> GET detail -> PATCH publish -> PATCH -> DELETE
const rdCreate = await req("POST", "/hr/rich-documents", { token: owner, body: { title: "FN_TEST_RichDoc", templateType: "POLICY", contentJson: { blocks: [] } } });
mark("POST", "/hr/rich-documents");
check("WRITE POST /hr/rich-documents 201", rdCreate, 201);
const rdId = rdCreate.body?.id;
if (rdId) {
  await hit("WRITE GET /hr/rich-documents/:id", "GET", `/hr/rich-documents/${rdId}`, { token: owner }, 200, "/hr/rich-documents/:id");
  await hit("WRITE PATCH /hr/rich-documents/:id/publish", "PATCH", `/hr/rich-documents/${rdId}/publish`, { token: owner }, 200, "/hr/rich-documents/:id/publish");
  await hit("WRITE PATCH /hr/rich-documents/:id", "PATCH", `/hr/rich-documents/${rdId}`, { token: owner, body: { title: "FN_TEST_RichDoc_v2" } }, 200, "/hr/rich-documents/:id");
  await hit("WRITE DELETE /hr/rich-documents/:id", "DELETE", `/hr/rich-documents/${rdId}`, { token: owner }, 200, "/hr/rich-documents/:id");
  await hit("WRITE rich-doc gone -> 404", "GET", `/hr/rich-documents/${rdId}`, { token: owner }, 404, "/hr/rich-documents/:id");
}

// (3) Document: POST -> GET list -> PATCH -> DELETE (soft delete)
const docCreate = await req("POST", "/hr/documents", { token: owner, body: { name: "FN_TEST_Doc", type: "OTHER", fileUrl: "https://example.com/fn-test.pdf" } });
mark("POST", "/hr/documents");
check("WRITE POST /hr/documents 201", docCreate, 201);
const docId = docCreate.body?.id;
if (docId) {
  await hit("WRITE PATCH /hr/documents/:id", "PATCH", `/hr/documents/${docId}`, { token: owner, body: { description: "FN_TEST_desc" } }, 200, "/hr/documents/:id");
  await hit("WRITE DELETE /hr/documents/:id", "DELETE", `/hr/documents/${docId}`, { token: owner }, 200, "/hr/documents/:id");
  await hit("ERR DELETE document missing", "DELETE", "/hr/documents/999999", { token: owner }, 404, "/hr/documents/:id");
}

// (4) Goal: POST (HttpCode 200) -> GET list -> key-results GET (real goal) -> PATCH item -> DELETE
const goalCreate = await req("POST", "/hr/performance/goals", { token: owner, body: { userId: ownerId, title: "FN_TEST_Goal", startDate: "2025-01-01", endDate: "2025-12-31" } });
mark("POST", "/hr/performance/goals");
check("WRITE POST /hr/performance/goals 200", goalCreate, 200);
const goalId = goalCreate.body?.id;
if (goalId) {
  await hit("WRITE key-results real goal 200", "GET", `/hr/performance/key-results?goalId=${goalId}`, { token: owner }, 200, "/hr/performance/key-results");
  await hit("WRITE PATCH goal collection", "PATCH", "/hr/performance/goals", { token: owner, body: { goalId, progress: 25 } }, 201, "/hr/performance/goals");
  await hit("WRITE PATCH /hr/performance/goals/:id", "PATCH", `/hr/performance/goals/${goalId}`, { token: owner, body: { progress: 50 } }, 200, "/hr/performance/goals/:id");
  await hit("WRITE DELETE /hr/performance/goals/:id", "DELETE", `/hr/performance/goals/${goalId}`, { token: owner }, 200, "/hr/performance/goals/:id");
}

// (5) One-on-one: POST -> GET list -> PATCH -> DELETE
const futureAt = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000).toISOString();
const oooCreate = await req("POST", "/hr/performance/one-on-ones", { token: owner, body: { employeeId: empId, scheduledAt: futureAt, agenda: "FN_TEST_1on1" } });
mark("POST", "/hr/performance/one-on-ones");
check("WRITE POST /hr/performance/one-on-ones 201", oooCreate, 201);
const oooId = oooCreate.body?.id;
if (oooId) {
  await hit("WRITE PATCH /hr/performance/one-on-ones/:id", "PATCH", `/hr/performance/one-on-ones/${oooId}`, { token: owner, body: { status: "COMPLETED", notes: "FN_TEST_notes" } }, 200, "/hr/performance/one-on-ones/:id");
  await hit("WRITE DELETE /hr/performance/one-on-ones/:id", "DELETE", `/hr/performance/one-on-ones/${oooId}`, { token: owner }, 200, "/hr/performance/one-on-ones/:id");
}

console.log(`\n[hr-b] distinct routes exercised: ${routes.size}`);
process.exit(report("hr-b") ? 0 : 1);
