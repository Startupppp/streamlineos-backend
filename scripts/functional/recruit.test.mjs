import { mint, req, check, report } from "./harness.mjs";

// Functional tests for the "recruit" domain group:
//   modules: hr-recruitment (candidates/jobs/pipeline/sourcing/offers/records/automation/recruiters)
//            hr-interviews   (interviews/scorecards/hiring-flows/offers/reports)
// Guards observed in controllers:
//   - JwtAuthGuard on every controller  -> no token => 401
//   - @CheckAbility("manage","hr:employees") via AbilityGuard (jobs create/update/delete, candidate import, offer-letter)
//   - inline role-string gates: RECRUITMENT_ADMIN_ROLES=[CEO,HR,ADMIN], MANAGER_ROLES=[+HR_MANAGER],
//     OFFER_ROLES=[CEO,ADMIN,HR,BRANCH_HR]; offer submit=HR|ADMIN, offer approve/reject=CEO
// Happy-path token = org-owner elevated to role CEO: isOrgOwner=true satisfies AbilityGuard ("manage all")
// AND role CEO satisfies the ADMIN/MANAGER/OFFER role-string gates. A literal OWNER-role token would be
// 403 on the role-string gates (OWNER is not whitelisted) -- noted, not a defect.

const NO = undefined;
let boss, hr, member, sales;

const seen = new Set();
async function call(method, path, opts, pattern) {
  seen.add(`${method} ${pattern ?? path}`);
  return req(method, path, opts);
}
const ok = (cond, want = 200) => ({ status: cond ? want : 0 });

async function run() {
  boss = await mint("owner", { role: "CEO" }); // isOrgOwner + CEO -> passes ability + all role gates
  hr = await mint("owner", { role: "HR" }); //   for offer submit-for-approval (HR|ADMIN only)
  member = await mint("member"); //              role MEMBER, not owner -> RBAC negative
  sales = await mint("salesRep"); //             role SALES_REP -> RBAC negative

  const BOGUS = 99999999; // non-existent numeric id
  let candidateId = 1; // seeded org has 3 candidates (ids start at 1)

  // ---- discover a real candidate id from the working list endpoint ----
  {
    const r = await call("GET", "/hr/recruitment/candidates", { token: boss });
    check("GET candidates (owner happy)", r, 200);
    const arr = Array.isArray(r.body) ? r.body : (r.body?.data ?? []);
    if (arr[0]?.id) candidateId = arr[0].id;
    const rm = await call("GET", "/hr/recruitment/candidates", { token: member });
    check("GET candidates (member, auth-only not over-gated)", rm, 200);
    const rn = await call("GET", "/hr/recruitment/candidates", { token: NO });
    check("GET candidates (no token -> 401)", rn, 401);
  }

  // =====================================================================
  // CANDIDATES controller  /hr/recruitment/candidates
  // =====================================================================
  // POST /candidates  (auth-only). Validation + non-destructive create/verify/delete.
  check("POST candidates (bad body -> 400)", await call("POST", "/hr/recruitment/candidates", { token: boss, body: {} }), 400);
  {
    const email = `fn_test_${Date.now()}@example.com`;
    const cr = await call("POST", "/hr/recruitment/candidates", {
      token: boss,
      body: { firstName: "FN_TEST_First", lastName: "FN_TEST_Last", email },
    });
    check("POST candidates (create FN_TEST_ -> 201)", cr, 201);
    const newId = cr.body?.id;
    // verify via list (detail endpoint is broken, see bug below)
    const list = await call("GET", "/hr/recruitment/candidates", { token: boss });
    const present = Array.isArray(list.body) && list.body.some((c) => c.id === newId);
    check("verify created candidate present in list", ok(present), 200);
    if (newId) {
      check("DELETE candidates/:id (cleanup FN_TEST_ -> 200)", await call("DELETE", `/hr/recruitment/candidates/${newId}`, { token: boss }, "DELETE /hr/recruitment/candidates/:id"), 200);
    }
  }
  // DELETE non-existent -> 404
  check("DELETE candidates/:id (non-existent -> 404)", await call("DELETE", `/hr/recruitment/candidates/${BOGUS}`, { token: boss }, "DELETE /hr/recruitment/candidates/:id"), 404);
  // GET detail  (CORRECT contract = 200 for real / 404 for missing). Backend returns 500 -> defect.
  check("GET candidates/:id (real id, expect 200)", await call("GET", `/hr/recruitment/candidates/${candidateId}`, { token: boss }, "GET /hr/recruitment/candidates/:id"), 200);
  check("GET candidates/:id (non-existent, expect 404)", await call("GET", `/hr/recruitment/candidates/${BOGUS}`, { token: boss }, "GET /hr/recruitment/candidates/:id"), 404);
  check("GET candidates/:id (non-numeric -> 400 ParseIntPipe)", await call("GET", "/hr/recruitment/candidates/abc", { token: boss }, "GET /hr/recruitment/candidates/:id"), 400);
  // PATCH detail (non-existent -> 404, no mutation of real rows)
  check("PATCH candidates/:id (non-existent -> 404)", await call("PATCH", `/hr/recruitment/candidates/${BOGUS}`, { token: boss, body: { firstName: "x" } }, "PATCH /hr/recruitment/candidates/:id"), 404);
  // stage transition
  check("PATCH candidates/:id/stage (bad enum -> 400)", await call("PATCH", `/hr/recruitment/candidates/${candidateId}/stage`, { token: boss, body: { stage: "NOPE" } }, "PATCH /hr/recruitment/candidates/:id/stage"), 400);
  check("PATCH candidates/:id/stage (non-existent -> 404)", await call("PATCH", `/hr/recruitment/candidates/${BOGUS}/stage`, { token: boss, body: { stage: "SCREENING" } }, "PATCH /hr/recruitment/candidates/:id/stage"), 404);
  // sla
  check("GET candidates/:id/sla (owner happy)", await call("GET", `/hr/recruitment/candidates/${candidateId}/sla`, { token: boss }, "GET /hr/recruitment/candidates/:id/sla"), 200);
  check("PATCH candidates/:id/sla (bad body -> 400)", await call("PATCH", `/hr/recruitment/candidates/${candidateId}/sla`, { token: boss, body: {} }, "PATCH /hr/recruitment/candidates/:id/sla"), 400);
  // applications
  check("POST candidates/:id/applications (bad body -> 400)", await call("POST", `/hr/recruitment/candidates/${candidateId}/applications`, { token: boss, body: {} }, "POST /hr/recruitment/candidates/:id/applications"), 400);
  // bgv-status (ADMIN role gate)
  check("PATCH candidates/:id/bgv-status (member -> 403)", await call("PATCH", `/hr/recruitment/candidates/${candidateId}/bgv-status`, { token: member, body: { bgvStatus: "INITIATED" } }, "PATCH /hr/recruitment/candidates/:id/bgv-status"), 403);
  check("PATCH candidates/:id/bgv-status (bad body -> 400)", await call("PATCH", `/hr/recruitment/candidates/${candidateId}/bgv-status`, { token: boss, body: {} }, "PATCH /hr/recruitment/candidates/:id/bgv-status"), 400);
  // bulk-import / import / bulk-reject  (role / ability gated)
  check("POST candidates/bulk-import (member -> 403)", await call("POST", "/hr/recruitment/candidates/bulk-import", { token: member, body: { rows: [{ firstName: "FN_TEST_a", lastName: "FN_TEST_b", email: "fn_test_bi@example.com" }] } }), 403);
  check("POST candidates/bulk-import (bad body -> 400)", await call("POST", "/hr/recruitment/candidates/bulk-import", { token: boss, body: {} }), 400);
  check("POST candidates/import (member ability -> 403)", await call("POST", "/hr/recruitment/candidates/import", { token: member, body: { candidates: [] } }), 403);
  check("POST candidates/import (bad body -> 400)", await call("POST", "/hr/recruitment/candidates/import", { token: boss, body: {} }), 400);
  check("POST candidates/bulk-reject (member -> 403)", await call("POST", "/hr/recruitment/candidates/bulk-reject", { token: member, body: { candidateIds: [1] } }), 403);
  check("POST candidates/bulk-reject (bad body -> 400)", await call("POST", "/hr/recruitment/candidates/bulk-reject", { token: boss, body: {} }), 400);

  // =====================================================================
  // JOBS controller  /hr/recruitment
  // =====================================================================
  check("GET jobs (no token -> 401)", await call("GET", "/hr/recruitment/jobs", { token: NO }), 401);
  check("GET jobs (owner happy, expect 200)", await call("GET", "/hr/recruitment/jobs", { token: boss }), 200);
  check("POST jobs (member ability -> 403)", await call("POST", "/hr/recruitment/jobs", { token: member, body: { title: "FN_TEST_Job" } }), 403);
  check("POST jobs (bad body -> 400)", await call("POST", "/hr/recruitment/jobs", { token: boss, body: {} }), 400);
  check("GET jobs/:id (expect 200 or 404)", await call("GET", "/hr/recruitment/jobs/1", { token: boss }, "GET /hr/recruitment/jobs/:id"), [200, 404]);
  check("PATCH jobs/:id (member ability -> 403)", await call("PATCH", "/hr/recruitment/jobs/1", { token: member, body: { title: "x" } }, "PATCH /hr/recruitment/jobs/:id"), 403);
  check("DELETE jobs/:id (member ability -> 403)", await call("DELETE", "/hr/recruitment/jobs/1", { token: member }, "DELETE /hr/recruitment/jobs/:id"), 403);
  check("POST jobs/:id/publish (member role -> 403)", await call("POST", "/hr/recruitment/jobs/1/publish", { token: member, body: { platforms: ["LINKEDIN"] } }, "POST /hr/recruitment/jobs/:id/publish"), 403);
  check("GET jobs/:id/recruiters (expect 200 or 404)", await call("GET", "/hr/recruitment/jobs/1/recruiters", { token: boss }, "GET /hr/recruitment/jobs/:id/recruiters"), [200, 404]);
  check("POST jobs/:id/recruiters (member role -> 403)", await call("POST", "/hr/recruitment/jobs/1/recruiters", { token: member, body: { userId: "x" } }, "POST /hr/recruitment/jobs/:id/recruiters"), 403);
  check("DELETE jobs/:id/recruiters (member role -> 403)", await call("DELETE", "/hr/recruitment/jobs/1/recruiters", { token: member, body: { userId: "x" } }, "DELETE /hr/recruitment/jobs/:id/recruiters"), 403);
  check("GET jobs/:id/share (expect 200 or 404)", await call("GET", "/hr/recruitment/jobs/1/share", { token: boss }, "GET /hr/recruitment/jobs/:id/share"), [200, 404]);
  check("GET internal-jobs (owner happy, expect 200)", await call("GET", "/hr/recruitment/internal-jobs", { token: boss }), 200);
  check("POST internal-jobs/:id/apply (non-existent -> 404)", await call("POST", `/hr/recruitment/internal-jobs/${BOGUS}/apply`, { token: boss, body: {} }, "POST /hr/recruitment/internal-jobs/:id/apply"), 404);

  // =====================================================================
  // PIPELINE controller
  // =====================================================================
  check("GET pipeline (no token -> 401)", await call("GET", "/hr/recruitment/pipeline", { token: NO }), 401);
  check("GET pipeline (owner happy, expect 200)", await call("GET", "/hr/recruitment/pipeline", { token: boss }), 200);
  check("GET diversity-report (owner happy)", await call("GET", "/hr/recruitment/diversity-report", { token: boss }), 200);
  check("GET bgv-compliance (owner happy)", await call("GET", "/hr/recruitment/bgv-compliance", { token: boss }), 200);
  check("GET bgv-compliance (member role -> 403)", await call("GET", "/hr/recruitment/bgv-compliance", { token: member }), 403);

  // =====================================================================
  // SOURCING controller  (referrals / vendors / headcount)
  // =====================================================================
  check("GET referrals (no token -> 401)", await call("GET", "/hr/recruitment/referrals", { token: NO }), 401);
  check("GET referrals (owner happy, expect 200)", await call("GET", "/hr/recruitment/referrals", { token: boss }), 200);
  check("POST referrals (bad body -> 400)", await call("POST", "/hr/recruitment/referrals", { token: boss, body: {} }), 400);
  check("PATCH referrals/:id (member role -> 403)", await call("PATCH", "/hr/recruitment/referrals/1", { token: member, body: { status: "REVIEWING" } }, "PATCH /hr/recruitment/referrals/:id"), 403);
  check("GET vendors (owner happy, expect 200)", await call("GET", "/hr/recruitment/vendors", { token: boss }), 200);
  check("POST vendors (member role -> 403)", await call("POST", "/hr/recruitment/vendors", { token: member, body: { name: "FN_TEST_V" } }), 403);
  check("POST vendors (bad body -> 400)", await call("POST", "/hr/recruitment/vendors", { token: boss, body: {} }), 400);
  check("PATCH vendors/:id (member role -> 403)", await call("PATCH", "/hr/recruitment/vendors/1", { token: member, body: { name: "x" } }, "PATCH /hr/recruitment/vendors/:id"), 403);
  check("DELETE vendors/:id (member role -> 403)", await call("DELETE", "/hr/recruitment/vendors/1", { token: member }, "DELETE /hr/recruitment/vendors/:id"), 403);
  check("GET vendors/:id/submissions (no token -> 401)", await call("GET", "/hr/recruitment/vendors/1/submissions", { token: NO }, "GET /hr/recruitment/vendors/:id/submissions"), 401);
  check("POST vendors/:id/submissions (member role -> 403)", await call("POST", "/hr/recruitment/vendors/1/submissions", { token: member, body: { candidateId: 1 } }, "POST /hr/recruitment/vendors/:id/submissions"), 403);
  check("PATCH vendors/:id/submissions (member role -> 403)", await call("PATCH", "/hr/recruitment/vendors/1/submissions?submissionId=1", { token: member, body: {} }, "PATCH /hr/recruitment/vendors/:id/submissions"), 403);
  check("GET headcount (owner happy, expect 200)", await call("GET", "/hr/recruitment/headcount", { token: boss }), 200);
  check("POST headcount (bad body -> 400)", await call("POST", "/hr/recruitment/headcount", { token: boss, body: {} }), 400);
  check("PATCH headcount/:id (no token -> 401)", await call("PATCH", "/hr/recruitment/headcount/1", { token: NO, body: {} }, "PATCH /hr/recruitment/headcount/:id"), 401);
  check("DELETE headcount/:id (no token -> 401)", await call("DELETE", "/hr/recruitment/headcount/1", { token: NO }, "DELETE /hr/recruitment/headcount/:id"), 401);
  check("POST headcount/:id/approve (member role -> 403)", await call("POST", "/hr/recruitment/headcount/1/approve", { token: member }, "POST /hr/recruitment/headcount/:id/approve"), 403);
  check("POST headcount/:id/reject (member role -> 403)", await call("POST", "/hr/recruitment/headcount/1/reject", { token: member, body: {} }, "POST /hr/recruitment/headcount/:id/reject"), 403);
  check("POST headcount/:id/create-job (member role -> 403)", await call("POST", "/hr/recruitment/headcount/1/create-job", { token: member }, "POST /hr/recruitment/headcount/:id/create-job"), 403);

  // =====================================================================
  // RECRUITERS / PORTALS controller
  // =====================================================================
  check("GET portals (owner happy)", await call("GET", "/hr/recruitment/portals", { token: boss }), 200);
  check("GET portals (member role -> 403)", await call("GET", "/hr/recruitment/portals", { token: member }), 403);
  check("POST portals (member role -> 403)", await call("POST", "/hr/recruitment/portals", { token: member, body: { platform: "LINKEDIN" } }), 403);
  check("POST portals (bad body -> 400)", await call("POST", "/hr/recruitment/portals", { token: boss, body: { platform: "NOPE" } }), 400);
  check("POST portals/:platform/sync (member role -> 403)", await call("POST", "/hr/recruitment/portals/LINKEDIN/sync", { token: member }, "POST /hr/recruitment/portals/:platform/sync"), 403);
  check("GET recruiters (owner happy, expect 200)", await call("GET", "/hr/recruitment/recruiters", { token: boss }), 200);
  check("GET recruiters/activity (owner happy, expect 200)", await call("GET", "/hr/recruitment/recruiters/activity", { token: boss }), 200);
  check("POST recruiters/activity (bad body -> 400)", await call("POST", "/hr/recruitment/recruiters/activity", { token: boss, body: {} }), 400);

  // =====================================================================
  // CANDIDATE RECORDS controller  /hr/recruitment/candidates/:candidateId/...
  // =====================================================================
  const cbase = `/hr/recruitment/candidates/${candidateId}`;
  check("GET calibration (owner happy)", await call("GET", `${cbase}/calibration`, { token: boss }, "GET /hr/recruitment/candidates/:id/calibration"), 200);
  check("POST calibration (member role -> 403)", await call("POST", `${cbase}/calibration`, { token: member, body: {} }, "POST /hr/recruitment/candidates/:id/calibration"), 403);
  check("PATCH calibration (member role -> 403)", await call("PATCH", `${cbase}/calibration`, { token: member, body: { id: 1 } }, "PATCH /hr/recruitment/candidates/:id/calibration"), 403);
  check("GET referral (owner happy, expect 200)", await call("GET", `${cbase}/referral`, { token: boss }, "GET /hr/recruitment/candidates/:id/referral"), 200);
  check("POST referral (bad body -> 400)", await call("POST", `${cbase}/referral`, { token: boss, body: {} }, "POST /hr/recruitment/candidates/:id/referral"), 400);
  check("PATCH referral (no token -> 401)", await call("PATCH", `${cbase}/referral`, { token: NO, body: {} }, "PATCH /hr/recruitment/candidates/:id/referral"), 401);
  check("GET reference-checks (owner happy)", await call("GET", `${cbase}/reference-checks`, { token: boss }, "GET /hr/recruitment/candidates/:id/reference-checks"), 200);
  check("POST reference-checks (bad body -> 400)", await call("POST", `${cbase}/reference-checks`, { token: boss, body: {} }, "POST /hr/recruitment/candidates/:id/reference-checks"), 400);
  check("PATCH reference-checks/:checkId (non-existent -> 404)", await call("PATCH", `${cbase}/reference-checks/${BOGUS}`, { token: boss, body: {} }, "PATCH /hr/recruitment/candidates/:id/reference-checks/:checkId"), 404);
  check("DELETE reference-checks/:checkId (non-existent -> 404)", await call("DELETE", `${cbase}/reference-checks/${BOGUS}`, { token: boss }, "DELETE /hr/recruitment/candidates/:id/reference-checks/:checkId"), 404);
  check("GET documents (owner happy)", await call("GET", `${cbase}/documents`, { token: boss }, "GET /hr/recruitment/candidates/:id/documents"), 200);
  check("POST documents (bad body -> 400)", await call("POST", `${cbase}/documents`, { token: boss, body: {} }, "POST /hr/recruitment/candidates/:id/documents"), 400);
  check("GET documents/:docId/view (non-existent -> 404)", await call("GET", `${cbase}/documents/${BOGUS}/view`, { token: boss }, "GET /hr/recruitment/candidates/:id/documents/:docId/view"), 404);
  check("GET vault (owner happy)", await call("GET", `${cbase}/vault`, { token: boss }, "GET /hr/recruitment/candidates/:id/vault"), 200);
  check("GET vault (member role -> 403)", await call("GET", `${cbase}/vault`, { token: member }, "GET /hr/recruitment/candidates/:id/vault"), 403);
  check("POST vault (member role -> 403)", await call("POST", `${cbase}/vault`, { token: member, body: { filename: "fn.pdf", s3Key: "k", fileUrl: "https://e.x/f.pdf", fileType: "application/pdf", fileSize: 1 } }, "POST /hr/recruitment/candidates/:id/vault"), 403);
  check("GET vault/access-logs (owner happy)", await call("GET", `${cbase}/vault/access-logs`, { token: boss }, "GET /hr/recruitment/candidates/:id/vault/access-logs"), 200);
  check("GET vault/access-logs (member role -> 403)", await call("GET", `${cbase}/vault/access-logs`, { token: member }, "GET /hr/recruitment/candidates/:id/vault/access-logs"), 403);

  // =====================================================================
  // AUTOMATION controller (automations / messages / email-sequences)
  // =====================================================================
  check("GET automations (no token -> 401)", await call("GET", "/hr/recruitment/automations", { token: NO }), 401);
  check("GET automations (owner happy, expect 200)", await call("GET", "/hr/recruitment/automations", { token: boss }), 200);
  check("POST automations (member role -> 403)", await call("POST", "/hr/recruitment/automations", { token: member, body: { name: "FN_TEST_Auto", trigger: "STAGE_CHANGED", action: "SEND_EMAIL" } }), 403);
  check("POST automations (bad body -> 400)", await call("POST", "/hr/recruitment/automations", { token: boss, body: {} }), 400);
  check("PATCH automations/:id (member role -> 403)", await call("PATCH", "/hr/recruitment/automations/1", { token: member, body: {} }, "PATCH /hr/recruitment/automations/:id"), 403);
  check("DELETE automations/:id (member role -> 403)", await call("DELETE", "/hr/recruitment/automations/1", { token: member }, "DELETE /hr/recruitment/automations/:id"), 403);
  check("GET messages/threads (owner happy, expect 200)", await call("GET", "/hr/recruitment/messages/threads", { token: boss }), 200);
  check("PATCH messages/:id (no token -> 401)", await call("PATCH", "/hr/recruitment/messages/1", { token: NO }, "PATCH /hr/recruitment/messages/:id"), 401);
  check("GET email-sequences (owner happy, expect 200)", await call("GET", "/hr/recruitment/email-sequences", { token: boss }), 200);
  check("POST email-sequences (member role -> 403)", await call("POST", "/hr/recruitment/email-sequences", { token: member, body: { name: "FN_TEST_Seq" } }), 403);
  check("POST email-sequences (bad body -> 400)", await call("POST", "/hr/recruitment/email-sequences", { token: boss, body: {} }), 400);
  check("GET email-sequences/:id (no token -> 401)", await call("GET", "/hr/recruitment/email-sequences/1", { token: NO }, "GET /hr/recruitment/email-sequences/:id"), 401);
  check("PATCH email-sequences/:id (member role -> 403)", await call("PATCH", "/hr/recruitment/email-sequences/1", { token: member, body: {} }, "PATCH /hr/recruitment/email-sequences/:id"), 403);
  check("DELETE email-sequences/:id (member role -> 403)", await call("DELETE", "/hr/recruitment/email-sequences/1", { token: member }, "DELETE /hr/recruitment/email-sequences/:id"), 403);
  check("POST email-sequences/:id/enroll (member role -> 403)", await call("POST", "/hr/recruitment/email-sequences/1/enroll", { token: member, body: { candidateIds: [1] } }, "POST /hr/recruitment/email-sequences/:id/enroll"), 403);

  // =====================================================================
  // OFFERS (recruitment) controller  /hr/recruitment/candidates/:id/offers
  // =====================================================================
  const obase = `/hr/recruitment/candidates/${candidateId}/offers`;
  check("GET offers (member role -> 403)", await call("GET", obase, { token: member }, "GET /hr/recruitment/candidates/:id/offers"), 403);
  check("GET offers (owner happy, expect 200)", await call("GET", obase, { token: boss }, "GET /hr/recruitment/candidates/:id/offers"), 200);
  check("POST offers (member role -> 403)", await call("POST", obase, { token: member, body: {} }, "POST /hr/recruitment/candidates/:id/offers"), 403);
  check("PATCH offers/:offerId (member role -> 403)", await call("PATCH", `${obase}/1`, { token: member, body: {} }, "PATCH /hr/recruitment/candidates/:id/offers/:offerId"), 403);
  check("DELETE offers/:offerId (member role -> 403)", await call("DELETE", `${obase}/1`, { token: member }, "DELETE /hr/recruitment/candidates/:id/offers/:offerId"), 403);
  check("DELETE offers/:offerId (non-existent -> 404)", await call("DELETE", `${obase}/${BOGUS}`, { token: boss }, "DELETE /hr/recruitment/candidates/:id/offers/:offerId"), 404);
  check("POST offers/:offerId/submit-for-approval (member -> 403)", await call("POST", `${obase}/1/submit-for-approval`, { token: member }, "POST /hr/recruitment/candidates/:id/offers/:offerId/submit-for-approval"), 403);
  check("POST offers/:offerId/submit-for-approval (HR, non-existent -> 404)", await call("POST", `${obase}/${BOGUS}/submit-for-approval`, { token: hr }, "POST /hr/recruitment/candidates/:id/offers/:offerId/submit-for-approval"), 404);
  check("POST offers/:offerId/approve (member -> 403)", await call("POST", `${obase}/1/approve`, { token: member, body: {} }, "POST /hr/recruitment/candidates/:id/offers/:offerId/approve"), 403);
  check("POST offers/:offerId/approve (CEO, non-existent -> 404)", await call("POST", `${obase}/${BOGUS}/approve`, { token: boss, body: {} }, "POST /hr/recruitment/candidates/:id/offers/:offerId/approve"), 404);
  check("POST offers/:offerId/reject-approval (member -> 403)", await call("POST", `${obase}/1/reject-approval`, { token: member, body: {} }, "POST /hr/recruitment/candidates/:id/offers/:offerId/reject-approval"), 403);
  check("POST offers/:offerId/reject-approval (CEO, non-existent -> 404)", await call("POST", `${obase}/${BOGUS}/reject-approval`, { token: boss, body: {} }, "POST /hr/recruitment/candidates/:id/offers/:offerId/reject-approval"), 404);

  // =====================================================================
  // INTERVIEWS controller  /hr/recruitment/interviews
  // =====================================================================
  check("GET interviews/slas (no token -> 401)", await call("GET", "/hr/recruitment/interviews/slas", { token: NO }), 401);
  check("GET interviews/slas (owner happy)", await call("GET", "/hr/recruitment/interviews/slas", { token: boss }), 200);
  check("PUT interviews/slas (member role -> 403)", await call("PUT", "/hr/recruitment/interviews/slas", { token: member, body: { stage: "X", maxHours: 1, warningHours: 1 } }), 403);
  check("PUT interviews/slas (bad body -> 400)", await call("PUT", "/hr/recruitment/interviews/slas", { token: boss, body: {} }), 400);
  check("GET interviews/sla-report (owner happy)", await call("GET", "/hr/recruitment/interviews/sla-report", { token: boss }), 200);
  check("GET interviews/:id/scorecard/summary (member role -> 403)", await call("GET", "/hr/recruitment/interviews/1/scorecard/summary", { token: member }, "GET /hr/recruitment/interviews/:id/scorecard/summary"), 403);
  check("GET interviews/:id/scorecard/summary (non-existent -> 404)", await call("GET", `/hr/recruitment/interviews/${BOGUS}/scorecard/summary`, { token: boss }, "GET /hr/recruitment/interviews/:id/scorecard/summary"), 404);
  check("GET interviews/:id/ics (non-existent -> 404)", await call("GET", `/hr/recruitment/interviews/${BOGUS}/ics`, { token: boss }, "GET /hr/recruitment/interviews/:id/ics"), 404);

  // =====================================================================
  // INTERVIEWERS controller
  // =====================================================================
  check("GET interviewers/availability (no token -> 401)", await call("GET", "/hr/recruitment/interviewers/availability", { token: NO }), 401);
  check("GET interviewers/availability (owner happy)", await call("GET", `/hr/recruitment/interviewers/availability?date=2026-06-26&interviewerIds=${USERS_owner()}`, { token: boss }, "GET /hr/recruitment/interviewers/availability"), 200);
  check("GET interviewer-performance (owner happy, expect 200)", await call("GET", "/hr/recruitment/interviewer-performance", { token: boss }), 200);
  check("GET booking-links (owner happy)", await call("GET", "/hr/recruitment/booking-links", { token: boss }), 200);
  check("PATCH booking-links/:id (member role -> 403)", await call("PATCH", "/hr/recruitment/booking-links/1", { token: member }, "PATCH /hr/recruitment/booking-links/:id"), 403);
  check("PATCH booking-links/:id (non-existent -> 404)", await call("PATCH", `/hr/recruitment/booking-links/${BOGUS}`, { token: boss }, "PATCH /hr/recruitment/booking-links/:id"), 404);

  // =====================================================================
  // SCORECARDS controller
  // =====================================================================
  check("GET scorecard-templates (no token -> 401)", await call("GET", "/hr/recruitment/scorecard-templates", { token: NO }), 401);
  check("GET scorecard-templates (owner happy)", await call("GET", "/hr/recruitment/scorecard-templates", { token: boss }), 200);
  check("POST scorecard-templates (member role -> 403)", await call("POST", "/hr/recruitment/scorecard-templates", { token: member, body: { name: "x", criteria: [{ name: "a", weight: 1 }] } }), 403);
  check("POST scorecard-templates (bad body -> 400)", await call("POST", "/hr/recruitment/scorecard-templates", { token: boss, body: {} }), 400);
  {
    const cr = await call("POST", "/hr/recruitment/scorecard-templates", { token: boss, body: { name: "FN_TEST_Scorecard", criteria: [{ name: "Communication", weight: 100 }] } });
    check("POST scorecard-templates (create FN_TEST_ -> 201)", cr, 201);
    const id = cr.body?.id;
    if (id) {
      check("PATCH scorecard-templates/:id (update FN_TEST_)", await call("PATCH", `/hr/recruitment/scorecard-templates/${id}`, { token: boss, body: { name: "FN_TEST_Scorecard2" } }, "PATCH /hr/recruitment/scorecard-templates/:id"), 200);
      check("DELETE scorecard-templates/:id (cleanup -> 200)", await call("DELETE", `/hr/recruitment/scorecard-templates/${id}`, { token: boss }, "DELETE /hr/recruitment/scorecard-templates/:id"), 200);
    } else {
      check("PATCH scorecard-templates/:id (member -> 403)", await call("PATCH", "/hr/recruitment/scorecard-templates/1", { token: member, body: {} }, "PATCH /hr/recruitment/scorecard-templates/:id"), 403);
      check("DELETE scorecard-templates/:id (member -> 403)", await call("DELETE", "/hr/recruitment/scorecard-templates/1", { token: member }, "DELETE /hr/recruitment/scorecard-templates/:id"), 403);
    }
  }
  check("GET scorecard-analytics (owner happy)", await call("GET", "/hr/recruitment/scorecard-analytics", { token: boss }), 200);

  // =====================================================================
  // HIRING FLOWS controller  (all routes auth-only, no role gate)
  // =====================================================================
  check("GET hiring-flows (no token -> 401)", await call("GET", "/hr/recruitment/hiring-flows", { token: NO }), 401);
  check("GET hiring-flows (owner happy, expect 200)", await call("GET", "/hr/recruitment/hiring-flows", { token: boss }), 200);
  check("POST hiring-flows (bad body -> 400)", await call("POST", "/hr/recruitment/hiring-flows", { token: boss, body: {} }), 400);
  check("GET hiring-flows/:id (no token -> 401)", await call("GET", "/hr/recruitment/hiring-flows/1", { token: NO }, "GET /hr/recruitment/hiring-flows/:id"), 401);
  check("PATCH hiring-flows/:id (no token -> 401)", await call("PATCH", "/hr/recruitment/hiring-flows/1", { token: NO, body: {} }, "PATCH /hr/recruitment/hiring-flows/:id"), 401);
  check("DELETE hiring-flows/:id (no token -> 401)", await call("DELETE", "/hr/recruitment/hiring-flows/1", { token: NO }, "DELETE /hr/recruitment/hiring-flows/:id"), 401);
  check("GET hiring-flows/:id/rounds (no token -> 401)", await call("GET", "/hr/recruitment/hiring-flows/1/rounds", { token: NO }, "GET /hr/recruitment/hiring-flows/:id/rounds"), 401);
  check("POST hiring-flows/:id/rounds (bad body -> 400)", await call("POST", "/hr/recruitment/hiring-flows/1/rounds", { token: boss, body: {} }, "POST /hr/recruitment/hiring-flows/:id/rounds"), 400);
  check("PATCH hiring-flows/:id/rounds/:roundId (no token -> 401)", await call("PATCH", "/hr/recruitment/hiring-flows/1/rounds/1", { token: NO, body: {} }, "PATCH /hr/recruitment/hiring-flows/:id/rounds/:roundId"), 401);
  check("DELETE hiring-flows/:id/rounds/:roundId (no token -> 401)", await call("DELETE", "/hr/recruitment/hiring-flows/1/rounds/1", { token: NO }, "DELETE /hr/recruitment/hiring-flows/:id/rounds/:roundId"), 401);

  // =====================================================================
  // OFFERS (interviews) controller  (offer-templates / offer-letter)
  // =====================================================================
  check("GET offer-templates (no token -> 401)", await call("GET", "/hr/recruitment/offer-templates", { token: NO }), 401);
  check("GET offer-templates (owner happy, expect 200)", await call("GET", "/hr/recruitment/offer-templates", { token: boss }), 200);
  check("POST offer-templates (member role -> 403)", await call("POST", "/hr/recruitment/offer-templates", { token: member, body: { name: "FN_TEST_OT", htmlContent: "<p>x</p>" } }), 403);
  check("POST offer-templates (bad body -> 400)", await call("POST", "/hr/recruitment/offer-templates", { token: boss, body: {} }), 400);
  check("PATCH offer-templates/:id (member role -> 403)", await call("PATCH", "/hr/recruitment/offer-templates/1", { token: member, body: {} }, "PATCH /hr/recruitment/offer-templates/:id"), 403);
  check("DELETE offer-templates/:id (member role -> 403)", await call("DELETE", "/hr/recruitment/offer-templates/1", { token: member }, "DELETE /hr/recruitment/offer-templates/:id"), 403);
  check("POST offer-templates/:id/generate-pdf (no token -> 401)", await call("POST", "/hr/recruitment/offer-templates/1/generate-pdf", { token: NO, body: {} }, "POST /hr/recruitment/offer-templates/:id/generate-pdf"), 401);
  check("POST offer-letter (member ability -> 403)", await call("POST", "/hr/recruitment/offer-letter", { token: member, body: { candidateId: 1, jobPostingId: 1, salary: "1", startDate: "2026-01-01" } }), 403);
  check("POST offer-letter (bad body -> 400)", await call("POST", "/hr/recruitment/offer-letter", { token: boss, body: {} }), 400);

  // =====================================================================
  // REPORTS controller
  // =====================================================================
  check("POST reports/generate (owner happy)", await call("POST", "/hr/recruitment/reports/generate", { token: boss, body: { entity: "candidates", fields: ["firstName"], filters: {} } }), 200);
  check("POST reports/generate (bad body -> 400)", await call("POST", "/hr/recruitment/reports/generate", { token: boss, body: {} }), 400);
  check("GET reports/scheduled (member role -> 403)", await call("GET", "/hr/recruitment/reports/scheduled", { token: member }), 403);
  check("GET reports/scheduled (owner happy, expect 200)", await call("GET", "/hr/recruitment/reports/scheduled", { token: boss }), 200);
  check("POST reports/scheduled (member role -> 403)", await call("POST", "/hr/recruitment/reports/scheduled", { token: member, body: { name: "FN_TEST_R", reportConfig: { entity: "candidates", fields: ["firstName"], filters: {} }, schedule: "WEEKLY", recipients: ["fn_test@example.com"] } }), 403);
  check("POST reports/scheduled (bad body -> 400)", await call("POST", "/hr/recruitment/reports/scheduled", { token: boss, body: {} }), 400);
  check("DELETE reports/scheduled/:id (member role -> 403)", await call("DELETE", "/hr/recruitment/reports/scheduled/1", { token: member }, "DELETE /hr/recruitment/reports/scheduled/:id"), 403);
  check("GET analytics (owner happy)", await call("GET", "/hr/recruitment/analytics", { token: boss }), 200);
  check("GET stats (owner happy)", await call("GET", "/hr/recruitment/stats", { token: boss }), 200);

  console.log(`\n[recruit] distinct routes exercised: ${seen.size}`);
  process.exit(report("recruit") ? 0 : 1);
}

function USERS_owner() {
  return "a723ac2d-0b0a-4f24-a3ae-f4605af20bbb";
}

run().catch((e) => {
  console.error("FATAL", e);
  process.exit(2);
});
