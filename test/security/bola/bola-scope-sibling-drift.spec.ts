import { findScopeSiblingDrift, isCollectionShaped, resolvesScope } from "./scope-sibling-drift";
import { loadRouteSurface } from "./route-surface";

/**
 * `GET /deals/export` once ignored DataScope while `GET /deals` applied it, so
 * an `own`-scoped member exported every deal in the organization. Both carry
 * `crm:deals:read`, which is what made it reachable: holding the key that gets
 * you the scoped list also gets you the unscoped sibling.
 *
 * This freezes the current inventory of that shape. The numbers are a ratchet,
 * not an endorsement — they must fall, and a new drifting key fails the suite.
 * Each entry is a permission key where at least one collection read scopes and
 * at least one does not; not every one is a disclosure (a config list under an
 * already-checked parent is not), which is why the gate is a ratchet and the
 * verified disclosures are pinned separately below.
 */
const DRIFTING_KEYS: readonly string[] = [
  "accounting:journal:read",
  "build:goals:view",
  "build:tickets:view",
  "build:timesheets:view",
  "build:view",
  "crm:autonomy:view",
  "crm:clients:read",
  "crm:contacts:view",
  "crm:customer360:view",
  "crm:deals:read",
  "crm:leads:view",
  "hr:analytics:read",
  "hr:assets:view",
  "hr:attendance:view",
  "hr:cases:view",
  "hr:documents:view",
  "hr:employees:manage",
  "hr:employees:view",
  "hr:expenses:read",
  "hr:expenses:view",
  "hr:leaves:view",
  "hr:onboarding:manage",
  "hr:payroll:view",
  "hr:performance:view",
  "hr:salary:view",
  "hr:sensitive:view",
  "inventory:products:read",
  "inventory:purchase-orders:read",
  "inventory:sales-orders:read",
  "inventory:stock:read",
  "kb:articles:view",
  "kb:spaces:view",
  "payroll:runs:view",
  "payroll:salaries:view",
  "self:attendance",
  "self:payroll",
  "settings:rbac:manage",
  "settings:view",
  "sign:envelope:view",
  "support:reports:view",
  "support:tickets:view",
  "timesheets:entries:view",
  "timesheets:payroll:view",
];

const UNSCOPED_ROUTE_BASELINE = 335;

/**
 * Hand-verified disclosures: the unscoped route returns the same entity's rows
 * as its scoped sibling, under the same key, so an `own`-scoped holder reads
 * the whole organization. Each was read in full, not inferred from the counts.
 */
const VERIFIED_DISCLOSURES: ReadonlyMap<string, { key: string; sibling: string }> = new Map([
  [
    "GET /deals/aging",
    { key: "crm:deals:read", sibling: "GET /deals" },
  ],
  [
    "GET /clients/export",
    { key: "crm:clients:read", sibling: "GET /clients" },
  ],
  [
    "GET /leads/export",
    { key: "crm:leads:view", sibling: "GET /leads" },
  ],
  [
    "GET /contacts/export",
    { key: "crm:contacts:view", sibling: "GET /crm/people-slugs" },
  ],
  [
    "GET /kb/search",
    { key: "kb:articles:view", sibling: "GET /kb/articles" },
  ],
  [
    "GET /sign/reports/dashboard",
    { key: "sign:envelope:view", sibling: "GET /sign/envelopes" },
  ],
]);

describe("BOLA sweep — export and search apply their sibling list's DataScope", () => {
  const findings = findScopeSiblingDrift();

  it("ANTI-VACUITY: the detector sees both scoped and unscoped reads", () => {
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.scoped.length > 0 && f.unscoped.length > 0)).toBe(true);
  });

  it("SELF-TEST: a handler that resolves a scope is recognised, one that does not is not", () => {
    expect(resolvesScope("const scope = await resolveDealsReadScope(this.access, u);")).toBe(true);
    expect(resolvesScope("const viewAll = readRequestScope(req) === 'all';")).toBe(true);
    expect(resolvesScope("return this.deals.exportCsv(u.orgId);")).toBe(false);
  });

  it("SELF-TEST: collection shape excludes a single-record detail read", () => {
    const routes = loadRouteSurface();
    const detail = routes.find((r) => r.path === "/deals/:dealId" && r.verb === "GET");
    const collection = routes.find((r) => r.path === "/deals" && r.verb === "GET");
    expect(detail && isCollectionShaped(detail)).toBe(false);
    expect(collection && isCollectionShaped(collection)).toBe(true);
  });

  it("NO-NEW-DRIFT: no permission key gains a scope-drifting sibling", () => {
    const unexpected = findings
      .map((f) => f.permissionKey)
      .filter((k) => !DRIFTING_KEYS.includes(k));
    expect(unexpected).toEqual([]);
  });

  it("RATCHET: the drifting route count does not grow", () => {
    const total = findings.reduce((sum, f) => sum + f.unscoped.length, 0);
    expect(total).toBeLessThanOrEqual(UNSCOPED_ROUTE_BASELINE);
  });

  it("FIXED: GET /deals/export applies the same scope as GET /deals", () => {
    const deals = findings.find((f) => f.permissionKey === "crm:deals:read");
    expect(deals?.scoped).toContain("GET /deals");
    expect(deals?.scoped).toContain("GET /deals/export");
    expect(deals?.unscoped).not.toContain("GET /deals/export");
  });

  it("PINNED: each hand-verified disclosure still sits opposite a scoped sibling", () => {
    for (const [route, { key, sibling }] of VERIFIED_DISCLOSURES) {
      const finding = findings.find((f) => f.permissionKey === key);
      expect(finding).toBeDefined();
      const stillDrifting = finding?.unscoped.includes(route) ?? false;
      const siblingScoped = finding?.scoped.includes(sibling) ?? false;
      if (stillDrifting) expect(siblingScoped).toBe(true);
    }
  });
});
