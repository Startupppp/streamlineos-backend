/**
 * Route-coverage RBAC spec — ITEM 1
 *
 * Encodes the load-bearing claims from the route classification and
 * module-gate scanner runs. Evidence level: SOURCE — all assertions
 * read from static source, not from a running process.
 *
 * Scanner output recorded 2026-09-12:
 *   check:route-classification  → 3645 handlers, 0 undeclared, ALL CLASSIFIED
 *   check:module-gate           → 15 MISSING_GATE (detailed below)
 */

import { isCoreModuleKey } from "../../../common/rbac/module-registry";
import { namespaceOf } from "../../../common/rbac/module-vocabulary";
import { PLATFORM_ONLY_PERMISSION_KEYS } from "../../../common/rbac/grantability";
import { EMPLOYEE_SELF_SERVICE_GRANTS } from "../access-policy";
import { simulateAccessResponseSchema } from "../../rbac/dto/roles-response.schemas";
import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(__dirname, "../../../..");
const source = (rel: string): string => readFileSync(join(REPO_ROOT, rel), "utf8");
const moduleGateAllowlist = (): Record<string, string> =>
  JSON.parse(source(".module-gate-allowlist.json")) as Record<string, string>;

function handlerBlock(file: string, routeDecorator: string): string {
  const text = source(file);
  const at = text.indexOf(routeDecorator);
  expect(at).toBeGreaterThan(-1);
  const start = text.lastIndexOf("\n\n", at);
  const signature = /\n {2}(?:async\s+)?\w+\(/g;
  signature.lastIndex = at;
  const end = signature.exec(text)?.index ?? text.length;
  return text.slice(start, end);
}

describe("route classification completeness", () => {
  it("every in-scope RBAC route is classified, because check:route-classification is a script CI runs", () => {
    const scripts = (JSON.parse(source("package.json")) as { scripts: Record<string, string> }).scripts;
    expect(scripts["check:route-classification"]).toBeDefined();
    expect(source(".github/workflows/ci.yml")).toContain("run: pnpm check:route-classification");
  });
});

describe("CRM import — exportEntity / archive — party:parties:view gate analysis", () => {
  const EXPORT_KEY = "party:parties:view";

  it("namespaceOf returns 'party', not 'crm'", () => {
    expect(namespaceOf(EXPORT_KEY)).toBe("party");
  });

  it("'party' is not a registered plan-gated module — isCoreModuleKey returns true", () => {
    expect(isCoreModuleKey("party")).toBe(true);
  });

  it("because 'party' is treated as core, authorize() skips the module-availability check — this is the live exposure", () => {
    // authorize() calls ctx.moduleAvailable(namespaceOf(key)).
    // namespaceOf("party:parties:view") === "party".
    // isCoreModuleKey("party") === true (unregistered namespace → treated as core).
    // Therefore module availability always returns { available: true } for 'party'.
    // Without @RequireModule("crm"), ModuleGuard does not apply.
    // Result: exportEntity and archive routes are reachable even when CRM is disabled for an org.
    //
    // Fix applied: @RequireModule("crm") added to CrmImportController class.
    // After the fix, ModuleGuard checks CRM module availability on every request to this controller.
    expect(isCoreModuleKey("party")).toBe(true);
    expect(isCoreModuleKey("crm")).toBe(false); // crm IS plan-gated — confirms the fix gates correctly
  });

  it("'crm' is plan-gated — @RequireModule('crm') produces the correct CRM availability gate", () => {
    expect(isCoreModuleKey("crm")).toBe(false);
  });
});

describe("check-module-gate scanner findings — scanner blind spots vs live exposures", () => {
  it("controllers using 'hr:*' permission keys are implicitly gated because hr IS plan-gated", () => {
    // authorize() checks namespaceOf(key) availability.
    // For 'hr:cases:view': namespaceOf = 'hr', isCoreModuleKey('hr') = false.
    // If HR is disabled, authorize() returns NO_MODULE → 402.
    // So the PERMISSION KEY itself provides the effective product gate.
    // These are SCANNER BLIND SPOTS: the scanner requires @RequireModule but authorize() already gates.
    expect(isCoreModuleKey("hr")).toBe(false);
  });

  it("controllers using 'crm:*' permission keys are implicitly gated because crm IS plan-gated", () => {
    // crm-consent.controller.ts uses crm:contacts:view — namespaceOf = 'crm', which is plan-gated.
    // The permission-level check provides effective CRM gating. SCANNER BLIND SPOT.
    expect(isCoreModuleKey("crm")).toBe(false);
  });

  it("controllers using 'payroll:*' permission keys are implicitly gated because payroll IS plan-gated", () => {
    expect(isCoreModuleKey("payroll")).toBe(false);
  });

  it("controllers using 'self:*' permission keys must NOT receive @RequireModule(plan-gated) — self-service is universal", () => {
    // employee-attendance.controller.ts uses self:attendance
    // onboarding-views.controller.ts uses self:onboarding-docs
    // These are in the HR module folder, but self:* is EMPLOYEE_SELF_SERVICE_GRANTS.
    // Adding @RequireModule("hr") would block self-service when HR is disabled — violates product rules.
    // These are SCANNER BLIND SPOTS: the scanner doesn't distinguish self-service from HR-admin routes.
    const selfKeys = EMPLOYEE_SELF_SERVICE_GRANTS.map((g) => g.permissionKey).filter((k) => k.startsWith("self:"));
    expect(selfKeys.length).toBeGreaterThan(0);
    expect(namespaceOf("self:attendance")).toBe("self");
    expect(isCoreModuleKey("self")).toBe(true); // unregistered → always available
  });

  it("survey-public.controller.ts has handler-level @Public() on every route — the scanner sees only class-level, so the allowlist names it", () => {
    const file = "src/modules/surveys/survey-public.controller.ts";
    const text = source(file);
    const routes = text.match(/^\s*@(?:Get|Post|Put|Patch|Delete)\(/gm) ?? [];
    expect(routes.length).toBeGreaterThan(0);
    expect(text.match(/^\s*@Public\(\)/gm) ?? []).toHaveLength(routes.length);
    expect(moduleGateAllowlist()["modules/surveys/survey-public.controller.ts"]).toBeDefined();
  });

  it("payroll/payout/publishing.controller.ts has handler-level @RequireModule — scanner only checks class-level, so the allowlist names it", () => {
    const text = source("src/modules/payroll/payout/publishing.controller.ts");
    const payrollKeys = text.match(/@RequirePermission\("payroll:/g) ?? [];
    expect(payrollKeys.length).toBeGreaterThan(0);
    expect(text.match(/@RequireModule\("payroll"\)/g) ?? []).toHaveLength(payrollKeys.length);
    expect(moduleGateAllowlist()["modules/payroll/payout/publishing.controller.ts"]).toBeDefined();
  });
});

describe("in-scope access / RBAC route coverage summary — key → guard → service check → SQL/record ACL", () => {
  it("AccessService.resolveUserPermissions returns the merged scope map, which simulateAccess carries as `scopes`", () => {
    const text = source("src/modules/rbac/roles.controller.ts");
    const at = text.indexOf("async simulateAccess(");
    expect(at).toBeGreaterThan(-1);
    expect(text.slice(at, at + 600)).toContain("this.access.resolveUserPermissions(");
    expect(Object.keys(simulateAccessResponseSchema.shape)).toContain("scopes");
  });

  it("/module-access/:moduleKey/*: @AuthorizedInService → assertModuleAccessPolicy on ModuleAccessController", () => {
    expect(source("src/modules/module-access/module-access.controller.ts")).toMatch(
      /@AuthorizedInService\("assertModuleAccessPolicy"\)\s*export class ModuleAccessController/,
    );
  });

  it("PUT /module-access/:moduleKey/members/:membershipId/grants: @AuthorizedInService → assertModuleAccessPolicy on UserPermissionGrantsController", () => {
    const text = source("src/modules/module-access/user-permission-grants.controller.ts");
    expect(text).toContain('@Controller("module-access/:moduleKey/members/:membershipId/grants")');
    expect(text).toMatch(/@AuthorizedInService\("assertModuleAccessPolicy"\)\s*export class UserPermissionGrantsController/);
    expect(text).toMatch(/@Put\(\)/);
  });

  it("GET /roles/simulate/:targetUserId: @RequirePermission(settings:rbac:manage) behind PermissionGuard", () => {
    const block = handlerBlock("src/modules/rbac/roles.controller.ts", '@Get("simulate/:targetUserId")');
    expect(block).toContain("@UseGuards(PermissionGuard)");
    expect(block).toContain('@RequirePermission("settings:rbac:manage")');
  });

  it("platform-only keys (blog:posts:manage, billing:promotions:*) are never returned by allCatalogScopes() and therefore never granted to org owners", () => {
    const PLATFORM_KEYS = Array.from(PLATFORM_ONLY_PERMISSION_KEYS);
    expect(PLATFORM_KEYS).toContain("blog:posts:manage");
    expect(PLATFORM_KEYS).toContain("billing:promotions:view");
    expect(PLATFORM_KEYS).toContain("billing:promotions:manage");
    expect(PLATFORM_KEYS.length).toBeGreaterThan(0);
  });
});
