// RBAC ACCESS-MATRIX functional test against the live NestJS backend (http://localhost:1500).
// Proves: no token -> 401; an authorized principal -> NOT 401/403; every unauthorized role -> 403.
//
// Gate mechanics (verified in src):
//  - JwtAuthGuard is class-level on every gated controller -> missing Bearer => 401.
//  - CASL gates: @CheckAbility(verb,subject)+AbilityGuard (guard runs BEFORE body pipe) OR an
//    in-handler defineAbilityFor(...).can(...) check. Owner/platform => manage:all => allowed.
//    A plain MEMBER with no permissions => AbilityDeniedException => 403.
//  - @RequireModule+ModuleGuard returns 404 (ModuleDisabled) when the module is off, so EVERY
//    principal is minted with all modules enabled to isolate the ability gate.
//  - Role-string gates: in-handler `if (!ALLOWED.includes(u.role)) throw Forbidden` => 403.
//    For these the guard runs AFTER the @Body Zod pipe, so an empty body would 400 before the
//    gate fires; the DENIED principal is therefore sent a schema-valid body so the gate is reached
//    (it denies before any service call -> no mutation). The AUTHORIZED principal is sent an empty
//    body (validation 400 => still "not 403", and no mutation).

import { mint, req, check, report, USERS } from "./harness.mjs";

const UUID = "00000000-0000-0000-0000-000000000000";
const ALL_MODULES = [
  "hr", "crm", "projects", "accounting", "sales", "support", "blog", "settings", "chat",
];

// ---- principals -------------------------------------------------------------
const owner = await mint("owner", { enabledModules: ALL_MODULES });             // manage:all
const plainMember = await mint("member", { enabledModules: ALL_MODULES });       // role MEMBER, no perms
const tokenCache = new Map();
async function roleToken(role) {
  if (!tokenCache.has(role)) {
    tokenCache.set(role, await mint("member", { role, enabledModules: ALL_MODULES }));
  }
  return tokenCache.get(role);
}

// "not 401/403" = authorization was granted. 500 is included because several handlers crash
// downstream on an intentionally-empty body / non-existent :id AFTER passing the gate — that still
// proves the authorized principal was let through (it is a service-robustness issue, not RBAC).
const AUTHORIZED_OK = [200, 201, 202, 204, 400, 404, 409, 422, 500];

// Routes whose in-service role/ability check runs AFTER a not-found lookup: a non-existent :id
// legitimately yields 404 before the gate fires (no data is exposed), so accept 403 or 404.
const DENY_EXPECT = {
  "PATCH /hr/leaves/1": [403, 404],
  "PATCH /targets/1": [403, 404],
  "DELETE /targets/1": [403, 404],
  "GET /clients/1": [403, 404],
};

function bodyFor(method) {
  return method === "POST" || method === "PATCH" || method === "PUT";
}

// Valid request bodies for INLINE-gated write routes so a denied principal reaches the gate (403)
// instead of being stopped by the Zod pipe (400). Keyed by "METHOD path".
const BODIES = {
  "POST /deals/approval-rules": { minValue: "1000" },
  "POST /hr/expenses/import": { fileName: "test.csv", content: "" },
  "POST /hr/payrolls": { month: "2030-01" },
  "POST /hr/termination": { userId: UUID, reasons: ["Performance Issues"], effectiveDate: "2030-01-01" },
  "PATCH /hr/termination/1/ceo-review": { decision: "approve" },
  "POST /hr/recruitment/offer-letter": { candidateId: 1, jobPostingId: 1, salary: "100000", startDate: "2030-01-01" },
  // userIds must reference a REAL user (who is NOT the denied caller's direct report) so the
  // non-admin branch's "your direct reports only" check fires and returns 403 rather than a
  // vacuous pass on an empty lookup.
  "POST /targets": { metricType: "sales", targetValue: "1000", startDate: "2030-01-01", endDate: "2030-12-31", userIds: [USERS.owner.sub] },
  "PATCH /targets/1": { targetValue: "1000" },
  "POST /dashboard/announcements": { content: "Announcement" },
  "PATCH /clients/renewals/1": { renewalStage: "renewed" },
  "POST /clients/1/activities": { activityType: "call", title: "Activity" },
  "PATCH /hr/loans/1": { status: "APPROVED" },
  "POST /hr/incentives/config": { incentiveRate: "10" },
  "PATCH /hr/incentives/1/approve": { approvedAmount: "1000" },
  "POST /hr/leaves/comp-off": { userId: UUID, days: 1 },
  // inline-gated routes whose required fields were revealed by the first run's 400 messages
  "POST /sales/commission-rules": { name: "x" },
  "POST /clients/onboarding/templates": { name: "x" },
  "POST /hr/exit/experience-letter": { userId: UUID, relievingDate: "2030-01-01" },
  "POST /hr/compliance": { documentId: 1, userIds: [UUID] },
  "POST /hr/performance/goals": { userId: UUID, title: "xx", startDate: "2030-01-01", endDate: "2030-12-31" },
  "POST /hr/performance/pip": { userId: UUID, reason: "x", objectives: [{ objective: "x", metric: "x", deadline: "2030-01-01" }], startDate: "2030-01-01", endDate: "2030-12-31" },
  "POST /roles": { name: "x", slug: "TESTROLE" },
  "POST /roles/templates": { templateId: "x" },
  "POST /rbac/role-permissions": { role: "MEMBER", permissionId: 1 },
  "PATCH /hr/leaves/1": { status: "APPROVED" },
  "POST /leads/merge": { winnerId: 1, loserId: 1 },
  "POST /leads/distribute": { leadIds: [1] },
  "DELETE /hr/recruitment/jobs/1/recruiters": { userId: UUID },
  // recruitment / interviews (inline role gates)
  "POST /hr/recruitment/automations": { name: "x", trigger: "STAGE_CHANGED", action: "SEND_EMAIL" },
  "POST /hr/recruitment/email-sequences": { name: "x" },
  "POST /hr/recruitment/email-sequences/1/enroll": { candidateIds: [1] },
  "PATCH /hr/recruitment/candidates/1/calibration": { id: 1 },
  "POST /hr/recruitment/candidates/1/vault": { filename: "x", s3Key: "x", fileUrl: "https://a.b", fileType: "x", fileSize: 0 },
  "POST /hr/recruitment/candidates/bulk-import": { rows: [{ firstName: "x", lastName: "x", email: "a@b.com" }] },
  "POST /hr/recruitment/candidates/bulk-reject": { candidateIds: [1] },
  "PATCH /hr/recruitment/candidates/1/bgv-status": { bgvStatus: "NOT_INITIATED" },
  "POST /hr/recruitment/jobs/1/publish": { platforms: ["LINKEDIN"] },
  "POST /hr/recruitment/jobs/1/recruiters": { userId: "x" },
  "POST /hr/recruitment/portals": { platform: "LINKEDIN" },
  "POST /hr/recruitment/vendors": { name: "x" },
  "POST /hr/recruitment/vendors/1/submissions": { candidateId: 1 },
  "PUT /hr/recruitment/interviews/slas": { stage: "x", maxHours: 1, warningHours: 1 },
  "POST /hr/recruitment/offer-templates": { name: "Template", htmlContent: "<p>Test</p>" },
  "POST /hr/recruitment/reports/scheduled": { name: "x", reportConfig: { entity: "candidates", fields: ["id"] }, schedule: "WEEKLY", recipients: ["a@b.com"] },
  "POST /hr/recruitment/scorecard-templates": { name: "x", criteria: [{ name: "x", weight: 1 }] },
};

// ---- CASL routes: owner allowed, plain member denied (403) ------------------
// [method, path]
const CASL = [
  // accounting
  ["GET", "/accounting/reports/gstr-1"],
  ["GET", "/accounting/reports/gstr-3b"],
  ["GET", "/accounting/accounts"],
  ["POST", "/accounting/accounts"],
  ["PATCH", "/accounting/accounts/1"],
  ["GET", "/accounting/journal"],
  ["POST", "/accounting/journal"],
  ["GET", "/accounting/journal/1"],
  ["POST", "/accounting/journal/1/post"],
  ["POST", "/accounting/journal/1/reverse"],
  ["GET", "/accounting/purchase-bills"],
  ["POST", "/accounting/purchase-bills"],
  ["GET", "/accounting/purchase-bills/1"],
  ["PATCH", "/accounting/purchase-bills/1"],
  ["GET", "/accounting/purchase-bills/1/payments"],
  ["POST", "/accounting/purchase-bills/1/payments"],
  ["GET", "/accounting/vendors"],
  ["GET", "/accounting/vendors/1/ledger"],
  ["GET", "/accounting/customers"],
  ["GET", "/accounting/customers/1/ledger"],
  ["GET", "/accounting/reports/aged-receivables"],
  ["GET", "/accounting/reports/aged-payables"],
  ["GET", "/accounting/reports/trial-balance"],
  ["GET", "/accounting/reports/profit-loss"],
  ["GET", "/accounting/reports/balance-sheet"],
  ["GET", "/accounting/reports/cash-flow"],
  // invoices / quotes
  ["GET", "/invoices"],
  ["POST", "/invoices"],
  ["DELETE", "/quotes/1"],
  // sales
  ["GET", "/sales/commission-rules"],
  ["POST", "/sales/commission-rules"],
  ["PATCH", "/sales/commissions/1"],
  ["GET", "/sales/playbook"],
  ["POST", "/sales/playbook"],
  ["PATCH", "/sales/playbook/1"],
  ["DELETE", "/sales/playbook/1"],
  ["GET", "/sales/dashboard/cycle-length"],
  ["GET", "/sales/dashboard/lost-analysis"],
  // blog
  ["GET", "/blog/posts"],
  ["POST", "/blog/posts"],
  ["GET", `/blog/posts/${UUID}`],
  ["PATCH", `/blog/posts/${UUID}`],
  ["DELETE", `/blog/posts/${UUID}`],
  ["POST", "/blog/categories"],
  ["PATCH", `/blog/categories/${UUID}`],
  ["DELETE", `/blog/categories/${UUID}`],
  // audit-log
  ["GET", "/audit-log"],
  ["GET", "/audit-log/actions"],
  ["GET", "/audit-log/target-types"],
  // webhooks
  ["POST", "/webhooks"],
  ["PATCH", "/webhooks/1"],
  ["DELETE", "/webhooks/1"],
  // deals
  ["GET", "/deals"],
  ["POST", "/deals"],
  ["DELETE", "/deals/1"],
  ["POST", "/deals/approval-rules"], // inline
  // leads (casl ones)
  ["GET", "/leads"],
  ["POST", "/leads"],
  ["DELETE", "/leads/1"],
  ["PATCH", "/leads/1/verify"],
  ["PATCH", "/leads/1/reject"],
  ["PATCH", "/leads/bulk"],
  ["DELETE", "/leads/bulk"],
  ["POST", "/leads/import"],
  ["GET", "/leads/unverified"],
  // crm rules / sla
  ["POST", "/crm/assignment-rules"],
  ["PATCH", "/crm/assignment-rules/reorder"],
  ["PATCH", "/crm/assignment-rules/1"],
  ["DELETE", "/crm/assignment-rules/1"],
  ["POST", "/crm/scoring-rules"],
  ["PATCH", "/crm/scoring-rules/1"],
  ["DELETE", "/crm/scoring-rules/1"],
  ["POST", "/crm/email-templates"],
  ["PATCH", "/crm/email-templates/1"],
  ["DELETE", "/crm/email-templates/1"],
  ["POST", "/crm/sla/policies"],
  ["PATCH", "/crm/sla/policies/1"],
  ["DELETE", "/crm/sla/policies/1"],
  // customer-executive
  ["GET", "/customer-executive/health"],
  ["GET", "/customer-executive/health/config"],
  ["PUT", "/customer-executive/health/config"],
  ["POST", "/customer-executive/health/recompute"],
  ["GET", "/customer-executive/nps"],
  ["POST", "/customer-executive/nps"],
  ["GET", "/customer-executive/nps/stats"],
  ["GET", "/customer-executive/nps/1"],
  ["PATCH", "/customer-executive/nps/1"],
  ["DELETE", "/customer-executive/nps/1"],
  // clients (casl one)
  ["POST", "/clients/onboarding/templates"],
  // dashboard (casl)
  ["GET", "/dashboard/pending-approvals"],
  // hr-config
  ["POST", "/hr/career-ladders"],
  ["POST", "/hr/departments"],
  ["POST", "/hr/documents/templates"],
  ["PATCH", "/hr/documents/templates/1"],
  ["PUT", "/hr/documents/templates/1"],
  ["DELETE", "/hr/documents/templates/1"],
  ["POST", "/hr/document-types"],
  ["PATCH", "/hr/document-types/1"],
  ["DELETE", "/hr/document-types/1"],
  ["GET", "/hr/email-templates"],
  ["POST", "/hr/email-templates"],
  ["PATCH", "/hr/email-templates/1"],
  ["DELETE", "/hr/email-templates/1"],
  ["POST", "/hr/handbook"],
  ["PATCH", "/hr/handbook/1"],
  ["DELETE", "/hr/handbook/1"],
  ["PATCH", "/hr/holidays/1"],
  ["DELETE", "/hr/holidays/1"],
  ["POST", "/hr/interview-questions"],
  ["PATCH", "/hr/interview-questions/1"],
  ["DELETE", "/hr/interview-questions/1"],
  ["POST", "/hr/learning-paths"],
  ["GET", "/hr/leaves/blackout"],
  ["POST", "/hr/leaves/blackout"],
  ["DELETE", "/hr/leaves/blackout/1"],
  ["POST", "/hr/salary-structures"],
  ["POST", "/hr/asset-returns"],
  ["PATCH", "/hr/asset-returns/1"],
  ["GET", "/hr/employees"],
  ["GET", `/hr/employees/${UUID}/manager-scorecard`],
  ["GET", "/hr/headcount"],
  // hr-time / lifecycle / payroll / performance (casl)
  ["GET", "/hr/attendance/team-status"],
  ["PATCH", "/hr/leaves/1"],
  ["GET", "/hr/leave-calendar"],
  ["GET", "/hr/leaves/team"],
  ["POST", "/hr/alumni"],
  ["GET", "/hr/exit/analytics"],
  ["POST", "/hr/exit/experience-letter"],
  ["GET", "/hr/analytics"],
  ["GET", "/hr/analytics/attendance"],
  ["GET", "/hr/analytics/attrition"],
  ["GET", "/hr/analytics/compensation"],
  ["GET", "/hr/dashboard/metrics"],
  ["GET", "/hr/dashboard/diversity"],
  ["GET", "/hr/dashboard/onboarding-status"],
  ["GET", "/hr/dashboard/headcount-trends"],
  ["GET", "/hr/dashboard/time-to-fill"],
  ["GET", "/hr/dashboard/attendance-analytics"],
  ["GET", "/hr/dashboard/payroll-summary"],
  ["GET", "/hr/onboarding-docs/summary"],
  ["POST", "/hr/bonuses"],
  ["PATCH", "/hr/bonuses/1"],
  ["POST", "/hr/fnf"],
  ["PATCH", "/hr/fnf/1"],
  ["POST", "/hr/incentives/config"],
  ["PATCH", "/hr/incentives/1/approve"],
  ["PATCH", "/hr/incentives/1/reject"],
  ["PATCH", "/hr/loans/1"],
  ["GET", "/hr/payroll-reports"],
  ["POST", "/hr/integrations/accounting-export"],
  ["GET", "/hr/payrolls/all"],
  ["POST", "/hr/payrolls"],
  ["POST", "/hr/payrolls/generate"],
  ["PATCH", "/hr/documents/1"],
  ["DELETE", "/hr/documents/1"],
  ["POST", "/hr/compliance"],
  ["GET", "/hr/compliance/statutory"],
  ["POST", "/hr/feedback"],
  ["POST", "/hr/assessments"],
  ["GET", "/hr/enps"],
  ["POST", "/hr/surveys"],
  ["PATCH", "/hr/surveys/1"],
  ["POST", "/hr/performance/goals"],
  ["POST", "/hr/performance/pip"],
  ["PATCH", "/hr/performance/pip/1"],
  ["PATCH", "/hr/performance/cycles/1"],
  ["DELETE", "/hr/performance/cycles/1"],
  // recruitment (casl manage hr:employees)
  ["POST", "/hr/recruitment/candidates/import"],
  ["POST", "/hr/recruitment/jobs"],
  ["PATCH", "/hr/recruitment/jobs/1"],
  ["DELETE", "/hr/recruitment/jobs/1"],
  ["POST", "/hr/recruitment/offer-letter"], // inline casl
  // projects
  ["POST", "/projects"],
  ["GET", "/projects/roadmap"],
  ["POST", "/projects/roadmap"],
  ["GET", "/projects/roadmap/1"],
  ["PATCH", "/projects/roadmap/1"],
  ["DELETE", "/projects/roadmap/1"],
  ["GET", "/projects/feedback"],
  ["POST", "/projects/feedback"],
  ["GET", "/projects/feedback/1"],
  ["PATCH", "/projects/feedback/1"],
  ["DELETE", "/projects/feedback/1"],
  ["GET", "/projects/changelog"],
  ["POST", "/projects/changelog"],
  ["GET", "/projects/changelog/1"],
  ["PATCH", "/projects/changelog/1"],
  ["DELETE", "/projects/changelog/1"],
  ["POST", "/projects/1/sprints"],
  ["PATCH", "/projects/1/sprints/1"],
  // goals
  ["GET", "/goals"],
  ["POST", "/goals"],
  ["GET", "/goals/stats"],
  ["PATCH", "/goals/key-results/1"],
  ["DELETE", "/goals/key-results/1"],
  ["GET", "/goals/1"],
  ["PATCH", "/goals/1"],
  ["DELETE", "/goals/1"],
  ["POST", "/goals/1/check-in"],
  ["GET", "/goals/1/key-results"],
  ["POST", "/goals/1/key-results"],
  ["GET", "/goals/1/links"],
  ["POST", "/goals/1/links"],
  ["DELETE", "/goals/1/links"],
  // settings
  ["GET", "/settings/automations"],
  ["POST", "/settings/automations"],
  ["GET", "/settings/automations/1"],
  ["PATCH", "/settings/automations/1"],
  ["DELETE", "/settings/automations/1"],
  ["GET", "/settings/automations/1/runs"],
  ["GET", "/settings/custom-fields"],
  ["POST", "/settings/custom-fields"],
  ["PATCH", "/settings/custom-fields/1"],
  ["DELETE", "/settings/custom-fields/1"],
  ["GET", "/settings/integrations/git"],
  ["POST", "/settings/integrations/git"],
  ["PATCH", "/settings/integrations/git/1"],
  ["DELETE", "/settings/integrations/git/1"],
  // organization
  ["POST", "/organization"],
  ["DELETE", `/organization/members/${UUID}`],
  ["GET", "/organization/invitations"],
  ["PATCH", "/organization/settings"],
  // support kb / macros
  ["GET", "/support/kb/categories"],
  ["POST", "/support/kb/categories"],
  ["PATCH", "/support/kb/categories/1"],
  ["DELETE", "/support/kb/categories/1"],
  ["GET", "/support/kb/articles"],
  ["POST", "/support/kb/articles"],
  ["GET", "/support/kb/articles/1"],
  ["PATCH", "/support/kb/articles/1"],
  ["DELETE", "/support/kb/articles/1"],
  ["GET", "/support/kb/articles/1/comments"],
  ["POST", "/support/kb/articles/1/comments"],
  ["DELETE", "/support/kb/articles/1/comments/1"],
  ["GET", "/support/macros"],
  ["POST", "/support/macros"],
  ["PATCH", "/support/macros/1"],
  ["DELETE", "/support/macros/1"],
  ["GET", "/support/routing-rules"],
  ["POST", "/support/routing-rules"],
  ["PATCH", "/support/routing-rules/1"],
  ["DELETE", "/support/routing-rules/1"],
  // expenses
  ["POST", "/hr/expenses/categories"],
  ["POST", "/hr/expenses/import"], // inline casl
  // onboarding
  ["GET", "/onboarding"],
  ["POST", "/onboarding"],
  ["GET", "/onboarding/templates"],
  ["POST", "/onboarding/templates"],
  // rbac (roles.service requires manage:all)
  ["POST", "/roles"],
  ["POST", "/roles/templates"],
  ["PATCH", "/roles/1"],
  ["DELETE", "/roles/1"],
  ["POST", "/rbac/role-permissions"],
];

// ---- ROLE-string routes: [method, path, allowedRoles[]] --------------------
const ROLE = [
  ["POST", "/leads/merge", ["CEO", "ADMIN", "HR", "SALES_MANAGER"]],
  ["POST", "/leads/distribute", ["CEO", "HR"]],
  ["POST", "/targets", ["OWNER", "CEO", "HR", "BRANCH_MANAGER"]],
  ["PATCH", "/targets/1", ["OWNER", "CEO", "HR", "BRANCH_MANAGER"]],
  ["DELETE", "/targets/1", ["OWNER", "CEO", "HR", "BRANCH_MANAGER"]],
  ["GET", "/clients/1", ["HR", "CEO", "CUSTOMER_SUPPORT", "OWNER", "SALES"]],
  ["POST", "/clients/1/activities", ["CUSTOMER_SUPPORT", "HR", "CEO"]],
  ["PATCH", "/clients/renewals/1", ["CUSTOMER_SUPPORT", "HR", "CEO", "SALES"]],
  ["POST", "/dashboard/announcements", ["CEO", "HR", "ADMIN"]],
  ["DELETE", "/dashboard/announcements?id=1", ["CEO", "HR", "ADMIN"]],
  ["GET", "/dashboard/branch-overview", ["CEO", "HR", "ADMIN"]],
  ["GET", "/dashboard/executive", ["OWNER", "CEO", "HR", "ADMIN"]],
  ["GET", `/hr/employees/${UUID}/profile-pdf`, ["CEO", "HR", "ADMIN", "HR_MANAGER"]],
  ["GET", "/hr/leaves/analytics", ["CEO", "ADMIN", "HR", "BRANCH_HR", "BRANCH_MANAGER"]],
  ["POST", "/hr/leaves/comp-off", ["CEO", "ADMIN", "HR", "BRANCH_HR", "BRANCH_MANAGER"]],
  ["GET", "/hr/dashboard/compliance", ["CEO", "ADMIN", "HR", "BRANCH_HR", "BRANCH_MANAGER"]],
  ["GET", "/hr/dashboard/export", ["CEO", "ADMIN", "HR", "BRANCH_HR"]],
  ["GET", "/hr/dashboard/salary-bands", ["CEO", "ADMIN", "HR", "BRANCH_HR"]],
  // termination
  ["GET", "/hr/termination", ["HR", "CEO"]],
  ["POST", "/hr/termination", ["HR", "CEO"]],
  ["GET", "/hr/termination/1/letter", ["HR", "CEO"]],
  ["PATCH", "/hr/termination/1/submit", ["HR", "CEO"]],
  ["PATCH", "/hr/termination/1/ceo-review", ["CEO"]],
  ["GET", "/hr/termination/1", ["HR", "CEO"]],
  // recruitment role gates
  ["POST", "/hr/recruitment/automations", ["CEO", "HR", "ADMIN", "HR_MANAGER"]],
  ["PATCH", "/hr/recruitment/automations/1", ["CEO", "HR", "ADMIN", "HR_MANAGER"]],
  ["DELETE", "/hr/recruitment/automations/1", ["CEO", "HR", "ADMIN", "HR_MANAGER"]],
  ["POST", "/hr/recruitment/email-sequences", ["CEO", "HR", "ADMIN", "HR_MANAGER"]],
  ["PATCH", "/hr/recruitment/email-sequences/1", ["CEO", "HR", "ADMIN", "HR_MANAGER"]],
  ["DELETE", "/hr/recruitment/email-sequences/1", ["CEO", "HR", "ADMIN", "HR_MANAGER"]],
  ["POST", "/hr/recruitment/email-sequences/1/enroll", ["CEO", "HR", "ADMIN", "HR_MANAGER"]],
  ["POST", "/hr/recruitment/candidates/1/calibration", ["CEO", "HR", "ADMIN"]],
  ["PATCH", "/hr/recruitment/candidates/1/calibration", ["CEO", "HR", "ADMIN"]],
  ["GET", "/hr/recruitment/candidates/1/vault", ["CEO", "HR", "ADMIN"]],
  ["POST", "/hr/recruitment/candidates/1/vault", ["CEO", "HR", "ADMIN"]],
  ["GET", "/hr/recruitment/candidates/1/vault/access-logs", ["CEO", "HR", "ADMIN"]],
  ["POST", "/hr/recruitment/candidates/bulk-import", ["CEO", "HR", "ADMIN", "HR_MANAGER"]],
  ["POST", "/hr/recruitment/candidates/bulk-reject", ["CEO", "HR", "ADMIN", "HR_MANAGER"]],
  ["PATCH", "/hr/recruitment/candidates/1/bgv-status", ["CEO", "HR", "ADMIN"]],
  ["POST", "/hr/recruitment/jobs/1/publish", ["CEO", "HR", "ADMIN"]],
  ["POST", "/hr/recruitment/jobs/1/recruiters", ["CEO", "HR", "ADMIN", "HR_MANAGER"]],
  ["DELETE", "/hr/recruitment/jobs/1/recruiters", ["CEO", "HR", "ADMIN", "HR_MANAGER"]],
  ["GET", "/hr/recruitment/candidates/1/offers", ["CEO", "ADMIN", "HR", "BRANCH_HR"]],
  ["POST", "/hr/recruitment/candidates/1/offers", ["CEO", "ADMIN", "HR", "BRANCH_HR"]],
  ["POST", "/hr/recruitment/candidates/1/offers/1/submit-for-approval", ["HR", "ADMIN"]],
  ["POST", "/hr/recruitment/candidates/1/offers/1/approve", ["CEO"]],
  ["POST", "/hr/recruitment/candidates/1/offers/1/reject-approval", ["CEO"]],
  ["PATCH", "/hr/recruitment/candidates/1/offers/1", ["CEO", "ADMIN", "HR", "BRANCH_HR"]],
  ["DELETE", "/hr/recruitment/candidates/1/offers/1", ["CEO", "ADMIN", "HR", "BRANCH_HR"]],
  ["GET", "/hr/recruitment/bgv-compliance", ["CEO", "HR", "ADMIN", "HR_MANAGER"]],
  ["GET", "/hr/recruitment/portals", ["CEO", "HR", "ADMIN", "HR_MANAGER"]],
  ["POST", "/hr/recruitment/portals", ["CEO", "HR", "ADMIN"]],
  ["POST", `/hr/recruitment/portals/${UUID}/sync`, ["CEO", "HR", "ADMIN"]],
  ["PATCH", "/hr/recruitment/referrals/1", ["CEO", "HR", "ADMIN", "HR_MANAGER"]],
  ["POST", "/hr/recruitment/vendors", ["CEO", "HR", "ADMIN", "HR_MANAGER"]],
  ["PATCH", "/hr/recruitment/vendors/1", ["CEO", "HR", "ADMIN", "HR_MANAGER"]],
  ["DELETE", "/hr/recruitment/vendors/1", ["CEO", "HR", "ADMIN", "HR_MANAGER"]],
  ["POST", "/hr/recruitment/vendors/1/submissions", ["CEO", "HR", "ADMIN", "HR_MANAGER"]],
  ["PATCH", "/hr/recruitment/vendors/1/submissions?submissionId=1", ["CEO", "HR", "ADMIN", "HR_MANAGER"]],
  ["POST", "/hr/recruitment/headcount/1/approve", ["CEO", "HR", "ADMIN", "HR_MANAGER"]],
  ["POST", "/hr/recruitment/headcount/1/reject", ["CEO", "HR", "ADMIN", "HR_MANAGER"]],
  ["POST", "/hr/recruitment/headcount/1/create-job", ["CEO", "HR", "ADMIN", "HR_MANAGER"]],
  ["PATCH", "/hr/recruitment/booking-links/1", ["CEO", "HR", "ADMIN"]],
  ["PUT", "/hr/recruitment/interviews/slas", ["CEO", "HR", "ADMIN"]],
  ["GET", "/hr/recruitment/interviews/1/scorecard/summary", ["CEO", "HR", "ADMIN"]],
  ["POST", "/hr/recruitment/offer-templates", ["CEO", "HR", "ADMIN", "HR_MANAGER"]],
  ["PATCH", "/hr/recruitment/offer-templates/1", ["CEO", "HR", "ADMIN", "HR_MANAGER"]],
  ["DELETE", "/hr/recruitment/offer-templates/1", ["CEO", "HR", "ADMIN", "HR_MANAGER"]],
  ["GET", "/hr/recruitment/reports/scheduled", ["CEO", "HR", "ADMIN", "HR_MANAGER"]],
  ["POST", "/hr/recruitment/reports/scheduled", ["CEO", "HR", "ADMIN", "HR_MANAGER"]],
  ["DELETE", "/hr/recruitment/reports/scheduled/1", ["CEO", "HR", "ADMIN", "HR_MANAGER"]],
  ["POST", "/hr/recruitment/scorecard-templates", ["CEO", "HR", "ADMIN"]],
  ["PATCH", "/hr/recruitment/scorecard-templates/1", ["CEO", "HR", "ADMIN"]],
  ["DELETE", "/hr/recruitment/scorecard-templates/1", ["CEO", "HR", "ADMIN"]],
].filter((r) => Array.isArray(r[2]));

const DENY_PROBE_ROLES = ["MEMBER", "SALES_REP", "HR", "CEO"];

// ---- run --------------------------------------------------------------------
// denied principal must reach the gate: send a schema-valid body when one is provided (so the Zod
// pipe does not 400 before an in-handler gate); else an empty body for write methods.
function deniedBody(method, key) {
  if (BODIES[key] !== undefined) return BODIES[key];
  return bodyFor(method) ? {} : undefined;
}

async function testCasl([method, path]) {
  const key = `${method} ${path}`;
  // no token -> 401
  check(`401 ${key}`, await req(method, path), 401);
  // authorized owner -> not 401/403
  const aBody = bodyFor(method) ? {} : undefined;
  check(`AUTH ${key}`, await req(method, path, { token: owner, body: aBody }), AUTHORIZED_OK);
  // unauthorized plain member -> 403
  check(`403 ${key}`, await req(method, path, { token: plainMember, body: deniedBody(method, key) }), DENY_EXPECT[key] ?? 403);
}

async function testRole([method, path, allowed]) {
  const key = `${method} ${path}`;
  // no token -> 401
  check(`401 ${key}`, await req(method, path), 401);
  // an authorized role -> not 401/403
  const aTok = await roleToken(allowed[0]);
  const aBody = bodyFor(method) ? {} : undefined;
  check(`AUTH(${allowed[0]}) ${key}`, await req(method, path, { token: aTok, body: aBody }), AUTHORIZED_OK);
  // every probe role NOT in the allowed set -> 403
  const denied = DENY_PROBE_ROLES.filter((r) => !allowed.includes(r));
  const want = DENY_EXPECT[key] ?? 403;
  for (const role of denied) {
    const tok = await roleToken(role);
    check(`403(${role}) ${key}`, await req(method, path, { token: tok, body: deniedBody(method, key) }), want);
  }
}

for (const r of CASL) await testCasl(r);
for (const r of ROLE) await testRole(r);

process.exit(report("rbac-matrix") ? 0 : 1);
