import { mint, req, check, report } from "./harness.mjs";

// hr-c group: hr-payroll (payrolls/comp/bonuses/loans/incentives/reimbursements/fnf)
//             + hr-lifecycle (exit/termination/alumni/analytics/dashboard/onboarding-views)
// Notes on guard semantics discovered from source:
//  - Owner token: isOrgOwner=true => CASL "manage all" => passes every @CheckAbility.
//  - ModuleGuard checks enabledModules (NOT abilities): owner needs "hr" enabled or -> 404 MODULE_DISABLED.
//  - Several routes use inline ROLE-STRING gates (salary-bands / compliance / export => CEO|ADMIN|HR|BRANCH_HR;
//    termination create/submit => HR|CEO; ceo-review => CEO). These now go through hasRoleOrPrivileged,
//    so isOrgOwner/isPlatformAdmin PASS regardless of the literal role string. A plain owner token
//    (isOrgOwner=true) therefore passes these gates; only the role check itself decides for non-privileged users.
//  - Writes here have NO delete/undo endpoint, so we never persist a valid row:
//    valid-body writes are only sent with LOW-PRIV tokens (denied before the service runs) and
//    authorized writes are only sent with MALFORMED bodies (Zod 400 before the service runs).
//    Exceptions are genuinely read-only "writes": tax-calculator + accounting-export (no DB mutation).

const owner = await mint("owner", { enabledModules: ["hr", "crm"] });
const ownerHr = await mint("owner", { role: "HR", enabledModules: ["hr", "crm"] });
const ownerCeo = await mint("owner", { role: "CEO", enabledModules: ["hr", "crm"] });
const member = await mint("member");
const memberHr = await mint("member", { enabledModules: ["hr"] });
const salesRep = await mint("salesRep");

const BOGUS = 999999; // non-existent numeric id

async function main() {
  // ---------------------------------------------------------------------------
  // AUTH: every protected route with NO token -> 401
  // ---------------------------------------------------------------------------
  const protectedRoutes = [
    ["GET", "/hr/payrolls"],
    ["GET", "/hr/payrolls/all?year=2025"],
    ["POST", "/hr/payrolls"],
    ["POST", "/hr/payrolls/generate"],
    ["GET", `/hr/payrolls/${BOGUS}/download`],
    ["GET", "/hr/payroll-reports?year=2025"],
    ["GET", "/hr/payslips"],
    ["GET", "/hr/dashboard/payroll-summary"],
    ["GET", "/hr/dashboard/salary-bands"],
    ["GET", "/hr/analytics/compensation"],
    ["POST", "/hr/tax-calculator"],
    ["POST", "/hr/integrations/accounting-export"],
    ["GET", "/hr/bonuses"],
    ["POST", "/hr/bonuses"],
    ["PATCH", `/hr/bonuses/${BOGUS}`],
    ["GET", "/hr/loans"],
    ["POST", "/hr/loans"],
    ["PATCH", `/hr/loans/${BOGUS}`],
    ["GET", "/hr/incentives"],
    ["GET", "/hr/incentives/config"],
    ["POST", "/hr/incentives/config"],
    ["GET", "/hr/incentives/stats"],
    ["PATCH", `/hr/incentives/${BOGUS}/approve`],
    ["PATCH", `/hr/incentives/${BOGUS}/reject`],
    ["GET", "/hr/reimbursements"],
    ["POST", "/hr/reimbursements"],
    ["GET", "/hr/fnf"],
    ["POST", "/hr/fnf"],
    ["PATCH", `/hr/fnf/${BOGUS}`],
    ["GET", "/hr/alumni"],
    ["POST", "/hr/alumni"],
    ["GET", "/hr/exit/analytics"],
    ["POST", "/hr/exit/experience-letter"],
    ["GET", `/hr/exit/${BOGUS}/letter`],
    ["GET", `/hr/exit/${BOGUS}/progress`],
    ["PATCH", `/hr/exit/${BOGUS}/withdraw`],
    ["GET", "/hr/analytics"],
    ["GET", "/hr/analytics/attendance"],
    ["GET", "/hr/analytics/attrition"],
    ["GET", "/hr/dashboard/metrics"],
    ["GET", "/hr/dashboard/diversity"],
    ["GET", "/hr/dashboard/onboarding-status"],
    ["GET", "/hr/dashboard/headcount-trends"],
    ["GET", "/hr/dashboard/time-to-fill"],
    ["GET", "/hr/dashboard/attendance-analytics"],
    ["GET", "/hr/dashboard/compliance"],
    ["GET", "/hr/dashboard/export"],
    ["GET", "/hr/onboarding-docs/summary"],
    ["GET", "/hr/termination"],
    ["POST", "/hr/termination"],
    ["GET", `/hr/termination/${BOGUS}/letter`],
    ["PATCH", `/hr/termination/${BOGUS}/submit`],
    ["PATCH", `/hr/termination/${BOGUS}/ceo-review`],
    ["GET", `/hr/termination/${BOGUS}`],
  ];
  for (const [m, p] of protectedRoutes) {
    check(`AUTH ${m} ${p} -> 401`, await req(m, p), 401);
  }

  // ---------------------------------------------------------------------------
  // hr-payroll :: payrolls.controller
  // ---------------------------------------------------------------------------
  // GET list (auth-only): owner + member both 200 (org has 0 payrolls -> empty 200)
  check("GET /hr/payrolls owner", await req("GET", "/hr/payrolls", { token: owner }), 200);
  check("GET /hr/payrolls member (not over-gated)", await req("GET", "/hr/payrolls", { token: member }), 200);

  // GET all (ModuleGuard hr + AbilityGuard view hr:payroll)
  check("GET /hr/payrolls/all?year owner", await req("GET", "/hr/payrolls/all?year=2025", { token: owner }), 200);
  check("GET /hr/payrolls/all no query -> 400", await req("GET", "/hr/payrolls/all", { token: owner }), 400);
  check("GET /hr/payrolls/all RBAC memberHr -> 403", await req("GET", "/hr/payrolls/all?year=2025", { token: memberHr }), 403);
  // member without hr module -> ModuleGuard -> 404 MODULE_DISABLED
  check("GET /hr/payrolls/all no-module member -> 404", await req("GET", "/hr/payrolls/all?year=2025", { token: member }), 404);

  // POST /hr/payrolls (generateBulk, in-handler ability). owner+{} -> 400 (month missing), no persist.
  check("POST /hr/payrolls owner empty -> 400", await req("POST", "/hr/payrolls", { token: owner, body: {} }), 400);
  check("POST /hr/payrolls RBAC salesRep -> 403", await req("POST", "/hr/payrolls", { token: salesRep, body: { month: "2025-01" } }), 403);

  // POST /hr/payrolls/generate (ModuleGuard + AbilityGuard generate hr:payroll). owner+{} -> 400 (Zod), no persist.
  check("POST /hr/payrolls/generate owner empty -> 400", await req("POST", "/hr/payrolls/generate", { token: owner, body: {} }), 400);
  check("POST /hr/payrolls/generate RBAC memberHr -> 403", await req("POST", "/hr/payrolls/generate", { token: memberHr, body: { userId: "x", month: "2025-01" } }), 403);

  // GET payslip download non-existent -> 404
  check("GET /hr/payrolls/:id/download bogus -> 404", await req("GET", `/hr/payrolls/${BOGUS}/download`, { token: owner }), 404);
  check("GET /hr/payrolls/:id/download non-numeric -> 400", await req("GET", "/hr/payrolls/abc/download", { token: owner }), 400);

  // ---------------------------------------------------------------------------
  // hr-payroll :: payroll-reports.controller
  // ---------------------------------------------------------------------------
  check("GET /hr/payroll-reports owner", await req("GET", "/hr/payroll-reports?year=2025", { token: owner }), 200);
  check("GET /hr/payroll-reports RBAC member -> 403", await req("GET", "/hr/payroll-reports?year=2025", { token: member }), 403);

  check("GET /hr/payslips owner", await req("GET", "/hr/payslips", { token: owner }), 200);
  check("GET /hr/payslips member (own, not over-gated)", await req("GET", "/hr/payslips", { token: member }), 200);
  // member requesting ANOTHER user's payslips -> 403
  check("GET /hr/payslips other-user member -> 403", await req("GET", "/hr/payslips?userId=a723ac2d-0b0a-4f24-a3ae-f4605af20bbb", { token: member }), 403);

  // payroll-summary: compensation.service.getPayrollSummary now filters a VALID enum
  //   `status IN ('APPROVED','PENDING_APPROVAL')` (was the invalid "SUBMITTED" that 500'd) -> 200.
  check("GET /hr/dashboard/payroll-summary owner", await req("GET", "/hr/dashboard/payroll-summary", { token: owner }), 200);
  check("GET /hr/dashboard/payroll-summary RBAC member -> 403", await req("GET", "/hr/dashboard/payroll-summary", { token: member }), 403);

  // salary-bands: inline role gate (CEO|ADMIN|HR|BRANCH_HR) via hasRoleOrPrivileged.
  check("GET /hr/dashboard/salary-bands ownerHr(role=HR) -> 200", await req("GET", "/hr/dashboard/salary-bands", { token: ownerHr }), 200);
  check("GET /hr/dashboard/salary-bands plain owner(isOrgOwner) -> 200 (hasRoleOrPrivileged)", await req("GET", "/hr/dashboard/salary-bands", { token: owner }), 200);
  check("GET /hr/dashboard/salary-bands RBAC member -> 403", await req("GET", "/hr/dashboard/salary-bands", { token: member }), 403);

  check("GET /hr/analytics/compensation owner", await req("GET", "/hr/analytics/compensation", { token: owner }), 200);
  check("GET /hr/analytics/compensation RBAC member -> 403", await req("GET", "/hr/analytics/compensation", { token: member }), 403);

  // tax-calculator: auth-only, pure calc (no DB) -> safe happy path
  check("POST /hr/tax-calculator owner -> 200", await req("POST", "/hr/tax-calculator", { token: owner, body: { annualCtc: 1200000 } }), 200);
  check("POST /hr/tax-calculator member (not over-gated) -> 200", await req("POST", "/hr/tax-calculator", { token: member, body: { annualCtc: 600000 } }), 200);
  check("POST /hr/tax-calculator bad body -> 400", await req("POST", "/hr/tax-calculator", { token: owner, body: { annualCtc: -5 } }), 400);

  // accounting-export: AbilityGuard manage hr:integrations, read-only export -> safe happy path
  check("POST /hr/integrations/accounting-export owner -> 200", await req("POST", "/hr/integrations/accounting-export", { token: owner, body: { month: "2025-06", format: "JSON" } }), 200);
  check("POST /hr/integrations/accounting-export bad month -> 400", await req("POST", "/hr/integrations/accounting-export", { token: owner, body: { month: "2025" } }), 400);
  check("POST /hr/integrations/accounting-export RBAC member -> 403", await req("POST", "/hr/integrations/accounting-export", { token: member, body: { month: "2025-06" } }), 403);

  // ---------------------------------------------------------------------------
  // hr-payroll :: bonuses.controller
  // ---------------------------------------------------------------------------
  check("GET /hr/bonuses owner", await req("GET", "/hr/bonuses", { token: owner }), 200);
  check("GET /hr/bonuses member (not over-gated)", await req("GET", "/hr/bonuses", { token: member }), 200);
  // POST bonus: AbilityGuard manage hr:bonuses. low-priv valid body -> 403 (no persist).
  check("POST /hr/bonuses RBAC member -> 403", await req("POST", "/hr/bonuses", { token: member, body: { userId: "x", type: "SPOT", amount: 100 } }), 403);
  // owner malformed -> 400 (Zod after guard, before service) — no persist.
  check("POST /hr/bonuses owner malformed -> 400", await req("POST", "/hr/bonuses", { token: owner, body: {} }), 400);
  // PATCH non-existent bonus (owner passes guard) -> 404
  check("PATCH /hr/bonuses/:id bogus -> 404", await req("PATCH", `/hr/bonuses/${BOGUS}`, { token: owner, body: { status: "APPROVED" } }), 404);
  check("PATCH /hr/bonuses/:id RBAC member -> 403", await req("PATCH", `/hr/bonuses/${BOGUS}`, { token: member, body: { status: "APPROVED" } }), 403);
  check("PATCH /hr/bonuses/:id non-numeric -> 400", await req("PATCH", "/hr/bonuses/abc", { token: owner, body: { status: "APPROVED" } }), 400);

  // ---------------------------------------------------------------------------
  // hr-payroll :: loans.controller
  // ---------------------------------------------------------------------------
  check("GET /hr/loans owner", await req("GET", "/hr/loans", { token: owner }), 200);
  check("GET /hr/loans member (not over-gated)", await req("GET", "/hr/loans", { token: member }), 200);
  // POST loan is UNGATED (any auth user self-creates) -> only test malformed (no persist).
  check("POST /hr/loans malformed -> 400", await req("POST", "/hr/loans", { token: owner, body: {} }), 400);
  // PATCH loan: in-handler isLoanAdmin gate. member -> 403; owner bogus -> 404.
  check("PATCH /hr/loans/:id RBAC member -> 403", await req("PATCH", `/hr/loans/${BOGUS}`, { token: member, body: { status: "APPROVED" } }), 403);
  check("PATCH /hr/loans/:id bogus -> 404", await req("PATCH", `/hr/loans/${BOGUS}`, { token: owner, body: { status: "APPROVED" } }), 404);

  // ---------------------------------------------------------------------------
  // hr-payroll :: incentives.controller
  // ---------------------------------------------------------------------------
  check("GET /hr/incentives owner", await req("GET", "/hr/incentives", { token: owner }), 200);
  check("GET /hr/incentives member (not over-gated)", await req("GET", "/hr/incentives", { token: member }), 200);
  check("GET /hr/incentives/config owner", await req("GET", "/hr/incentives/config", { token: owner }), 200);
  check("GET /hr/incentives/stats owner", await req("GET", "/hr/incentives/stats", { token: owner }), 200);
  // POST config: in-handler canApprove. member valid -> 403 (no persist); owner malformed -> 400.
  check("POST /hr/incentives/config RBAC member -> 403", await req("POST", "/hr/incentives/config", { token: member, body: { incentiveRate: 5 } }), 403);
  check("POST /hr/incentives/config owner malformed -> 400", await req("POST", "/hr/incentives/config", { token: owner, body: {} }), 400);
  // PATCH approve/reject: in-handler canApprove; member -> 403; owner bogus -> 404.
  check("PATCH /hr/incentives/:id/approve RBAC member -> 403", await req("PATCH", `/hr/incentives/${BOGUS}/approve`, { token: member, body: { approvedAmount: "100" } }), 403);
  check("PATCH /hr/incentives/:id/approve bogus -> 404", await req("PATCH", `/hr/incentives/${BOGUS}/approve`, { token: owner, body: { approvedAmount: "100" } }), 404);
  check("PATCH /hr/incentives/:id/reject RBAC member -> 403", await req("PATCH", `/hr/incentives/${BOGUS}/reject`, { token: member }), 403);
  check("PATCH /hr/incentives/:id/reject bogus -> 404", await req("PATCH", `/hr/incentives/${BOGUS}/reject`, { token: owner }), 404);

  // ---------------------------------------------------------------------------
  // hr-payroll :: reimbursements.controller
  // ---------------------------------------------------------------------------
  check("GET /hr/reimbursements owner", await req("GET", "/hr/reimbursements", { token: owner }), 200);
  check("GET /hr/reimbursements member (not over-gated)", await req("GET", "/hr/reimbursements", { token: member }), 200);
  // POST reimbursement is UNGATED -> only malformed (no persist).
  check("POST /hr/reimbursements malformed -> 400", await req("POST", "/hr/reimbursements", { token: owner, body: {} }), 400);

  // ---------------------------------------------------------------------------
  // hr-payroll :: fnf.controller
  // ---------------------------------------------------------------------------
  check("GET /hr/fnf owner", await req("GET", "/hr/fnf", { token: owner }), 200);
  check("GET /hr/fnf member (not over-gated)", await req("GET", "/hr/fnf", { token: member }), 200);
  // POST fnf: AbilityGuard manage hr:exit. member valid -> 403; owner malformed -> 400.
  check("POST /hr/fnf RBAC member -> 403", await req("POST", "/hr/fnf", { token: member, body: { userId: "x" } }), 403);
  check("POST /hr/fnf owner malformed -> 400", await req("POST", "/hr/fnf", { token: owner, body: {} }), 400);
  // PATCH fnf: AbilityGuard manage hr:exit. owner bogus -> 404; member -> 403.
  check("PATCH /hr/fnf/:id bogus -> 404", await req("PATCH", `/hr/fnf/${BOGUS}`, { token: owner, body: { status: "APPROVED" } }), 404);
  check("PATCH /hr/fnf/:id RBAC member -> 403", await req("PATCH", `/hr/fnf/${BOGUS}`, { token: member, body: { status: "APPROVED" } }), 403);

  // ---------------------------------------------------------------------------
  // hr-lifecycle :: alumni.controller
  // ---------------------------------------------------------------------------
  check("GET /hr/alumni owner", await req("GET", "/hr/alumni", { token: owner }), 200);
  check("GET /hr/alumni member (not over-gated)", await req("GET", "/hr/alumni", { token: member }), 200);
  // POST alumni: AbilityGuard read hr:alumni. member -> 403 (no persist); owner malformed -> 400.
  check("POST /hr/alumni RBAC member -> 403", await req("POST", "/hr/alumni", { token: member, body: { userId: "x" } }), 403);
  check("POST /hr/alumni owner malformed -> 400", await req("POST", "/hr/alumni", { token: owner, body: {} }), 400);

  // ---------------------------------------------------------------------------
  // hr-lifecycle :: exit.controller
  // ---------------------------------------------------------------------------
  // analytics: in-handler userCan(approve hr:leaves). owner -> 200; member -> 403.
  check("GET /hr/exit/analytics owner", await req("GET", "/hr/exit/analytics", { token: owner }), 200);
  check("GET /hr/exit/analytics RBAC member -> 403", await req("GET", "/hr/exit/analytics", { token: member }), 403);
  // experience-letter: member valid -> 403 (no persist); owner malformed -> 400.
  check("POST /hr/exit/experience-letter RBAC member -> 403", await req("POST", "/hr/exit/experience-letter", { token: member, body: { userId: "x", relievingDate: "2025-01-01" } }), 403);
  check("POST /hr/exit/experience-letter owner malformed -> 400", await req("POST", "/hr/exit/experience-letter", { token: owner, body: {} }), 400);
  // letter / progress / withdraw: non-existent resignation -> 404
  check("GET /hr/exit/:id/letter bogus -> 404", await req("GET", `/hr/exit/${BOGUS}/letter`, { token: owner }), 404);
  check("GET /hr/exit/:id/progress bogus -> 404", await req("GET", `/hr/exit/${BOGUS}/progress`, { token: owner }), 404);
  check("PATCH /hr/exit/:id/withdraw bogus -> 404", await req("PATCH", `/hr/exit/${BOGUS}/withdraw`, { token: owner }), 404);
  check("GET /hr/exit/:id/letter non-numeric -> 400", await req("GET", "/hr/exit/abc/letter", { token: owner }), 400);

  // ---------------------------------------------------------------------------
  // hr-lifecycle :: hr-analytics.controller (controller-level AbilityGuard read hr:analytics)
  // ---------------------------------------------------------------------------
  check("GET /hr/analytics owner", await req("GET", "/hr/analytics", { token: owner }), 200);
  check("GET /hr/analytics RBAC member -> 403", await req("GET", "/hr/analytics", { token: member }), 403);
  check("GET /hr/analytics/attendance owner", await req("GET", "/hr/analytics/attendance?year=2025", { token: owner }), 200);
  check("GET /hr/analytics/attrition owner", await req("GET", "/hr/analytics/attrition", { token: owner }), 200);
  check("GET /hr/analytics/attrition RBAC member -> 403", await req("GET", "/hr/analytics/attrition", { token: member }), 403);

  // ---------------------------------------------------------------------------
  // hr-lifecycle :: hr-dashboard.controller
  // ---------------------------------------------------------------------------
  check("GET /hr/dashboard/metrics owner", await req("GET", "/hr/dashboard/metrics", { token: owner }), 200);
  check("GET /hr/dashboard/metrics RBAC member -> 403", await req("GET", "/hr/dashboard/metrics", { token: member }), 403);
  check("GET /hr/dashboard/diversity owner", await req("GET", "/hr/dashboard/diversity", { token: owner }), 200);
  check("GET /hr/dashboard/onboarding-status owner", await req("GET", "/hr/dashboard/onboarding-status", { token: owner }), 200);
  check("GET /hr/dashboard/headcount-trends owner", await req("GET", "/hr/dashboard/headcount-trends", { token: owner }), 200);
  check("GET /hr/dashboard/time-to-fill owner", await req("GET", "/hr/dashboard/time-to-fill", { token: owner }), 200);
  check("GET /hr/dashboard/attendance-analytics owner", await req("GET", "/hr/dashboard/attendance-analytics", { token: owner }), 200);
  // compliance: inline role gate (incl. BRANCH_MANAGER) via hasRoleOrPrivileged -> ownerHr 200, owner 200, member 403.
  check("GET /hr/dashboard/compliance ownerHr(role=HR) -> 200", await req("GET", "/hr/dashboard/compliance", { token: ownerHr }), 200);
  check("GET /hr/dashboard/compliance plain owner(isOrgOwner) -> 200 (hasRoleOrPrivileged)", await req("GET", "/hr/dashboard/compliance", { token: owner }), 200);
  check("GET /hr/dashboard/compliance RBAC member -> 403", await req("GET", "/hr/dashboard/compliance", { token: member }), 403);
  // export: inline role allowlist (CEO|ADMIN|HR|BRANCH_HR), CSV response.
  check("GET /hr/dashboard/export ownerHr(role=HR) -> 200", await req("GET", "/hr/dashboard/export", { token: ownerHr }), 200);
  check("GET /hr/dashboard/export RBAC member -> 403", await req("GET", "/hr/dashboard/export", { token: member }), 403);

  // ---------------------------------------------------------------------------
  // hr-lifecycle :: onboarding-views.controller (AbilityGuard manage hr:onboarding)
  // ---------------------------------------------------------------------------
  check("GET /hr/onboarding-docs/summary owner", await req("GET", "/hr/onboarding-docs/summary", { token: owner }), 200);
  check("GET /hr/onboarding-docs/summary RBAC member -> 403", await req("GET", "/hr/onboarding-docs/summary", { token: member }), 403);

  // ---------------------------------------------------------------------------
  // hr-lifecycle :: termination.controller
  // ---------------------------------------------------------------------------
  // list/getOne/getLetter: assertManageAccess => role HR|CEO OR userCan(manage hr:employees).
  // owner(isOrgOwner) passes via ability.
  const termList = await req("GET", "/hr/termination", { token: owner });
  check("GET /hr/termination owner", termList, 200);
  check("GET /hr/termination RBAC member -> 403", await req("GET", "/hr/termination", { token: member }), 403);

  let realTermId = null;
  if (Array.isArray(termList.body) && termList.body.length > 0) realTermId = termList.body[0].id;

  if (realTermId) {
    check("GET /hr/termination/:id real -> 200", await req("GET", `/hr/termination/${realTermId}`, { token: owner }), 200);
    check("GET /hr/termination/:id/letter real -> 200", await req("GET", `/hr/termination/${realTermId}/letter`, { token: owner }), 200);
  }
  check("GET /hr/termination/:id bogus -> 404", await req("GET", `/hr/termination/${BOGUS}`, { token: owner }), 404);
  check("GET /hr/termination/:id/letter bogus -> 404", await req("GET", `/hr/termination/${BOGUS}/letter`, { token: owner }), 404);
  check("GET /hr/termination/:id RBAC member -> 403", await req("GET", `/hr/termination/${BOGUS}`, { token: member }), 403);
  check("GET /hr/termination/:id non-numeric -> 400", await req("GET", "/hr/termination/abc", { token: owner }), 400);

  // create: role HR|CEO via hasRoleOrPrivileged. member valid body -> 403; owner(isOrgOwner) passes gate.
  const validTermBody = { userId: "00000000-0000-0000-0000-000000000000", reasons: ["Performance Issues"], effectiveDate: "2099-01-01" };
  check("POST /hr/termination RBAC member -> 403", await req("POST", "/hr/termination", { token: member, body: validTermBody }), 403);
  // plain owner passes the HR|CEO gate (isOrgOwner) then fails the employee lookup -> 404 (no row persisted).
  check("POST /hr/termination plain owner(isOrgOwner) passes gate -> 404 nonexistent employee", await req("POST", "/hr/termination", { token: owner, body: validTermBody }), 404);
  check("POST /hr/termination malformed -> 400", await req("POST", "/hr/termination", { token: ownerHr, body: {} }), 400);
  // ownerHr(role HR) valid body for a non-existent employee -> 404 (passes role gate, fails employee lookup; no real row persisted)
  check("POST /hr/termination ownerHr nonexistent employee -> 404", await req("POST", "/hr/termination", { token: ownerHr, body: validTermBody }), 404);

  // submit: role HR|CEO. member -> 403; ownerHr bogus -> 404.
  check("PATCH /hr/termination/:id/submit RBAC member -> 403", await req("PATCH", `/hr/termination/${BOGUS}/submit`, { token: member }), 403);
  check("PATCH /hr/termination/:id/submit ownerHr bogus -> 404", await req("PATCH", `/hr/termination/${BOGUS}/submit`, { token: ownerHr }), 404);

  // ceo-review: role CEO via hasRoleOrPrivileged. member -> 403; ownerHr(isOrgOwner) passes gate -> 404 bogus; ownerCeo bogus -> 404.
  check("PATCH /hr/termination/:id/ceo-review RBAC member -> 403", await req("PATCH", `/hr/termination/${BOGUS}/ceo-review`, { token: member, body: { decision: "approve" } }), 403);
  check("PATCH /hr/termination/:id/ceo-review ownerHr(isOrgOwner) passes CEO gate -> 404 bogus", await req("PATCH", `/hr/termination/${BOGUS}/ceo-review`, { token: ownerHr, body: { decision: "approve" } }), 404);
  check("PATCH /hr/termination/:id/ceo-review ownerCeo bogus -> 404", await req("PATCH", `/hr/termination/${BOGUS}/ceo-review`, { token: ownerCeo, body: { decision: "approve" } }), 404);
}

main().then(() => process.exit(report("hr-c") ? 0 : 1)).catch((e) => {
  console.error(e);
  process.exit(1);
});
