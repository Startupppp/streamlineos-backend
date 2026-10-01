import {
  findScopeSiblingDrift,
  handlerScopeEvidence,
  isCollectionShaped,
  resolvesScope,
} from "./scope-sibling-drift";
import { loadRouteSurface } from "./route-surface";
import { buildSourceIndex } from "./tenant-binding";

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
  // The catalog does not mark `sign:admin:manage` scopable, so every holder resolves `all` and the
  // three unscoped admin-config reads (settings, sweep-status, watermark-policies) cannot disclose
  // anything their scoped sibling would have withheld. Listed so a scopable sibling would fail here.
  "sign:admin:manage",
  "sign:audit:view",
  "support:reports:view",
  "support:tickets:view",
  // Arrived on the merge and became visible the way `tasks:read` did: `GET /surveys` and
  // `GET /surveys/:surveyId` started narrowing to what the caller created, so the key qualified
  // for the first time. Its two REAL siblings — the builder snapshot and the logic rules, the
  // survey's whole content under a `scopable` key — were repaired rather than listed here; see
  // `FIXED: the survey's content reads narrow like the survey itself` below. What is left is
  // `GET /surveys/templates`, and that route reads no table at all: `SurveyTemplateService.list()`
  // returns a hard-coded in-process catalog, so there is no row any scope could have withheld.
  // Pinned to exactly that route below, so this entry cannot absorb a second one.
  "surveys:view",
  "tasks:read",
  "timesheets:billing:view",
  "timesheets:entries:view",
  "timesheets:payroll:view",
];

/**
 * 328 -> 339, re-pinned 2026-09-12, and the move is the MERGE — it has been failing since
 * `2697cd5b1` brought Inventory, CRM, Timesheets and SignOS onto main's tree, and `87ae17f82`
 * restated two other floors without restating this one. Measured, not guessed: the detector run
 * against the tree at `ccb90c45d` (where 328 was set) still answers 328, and against this tree
 * 339, so nothing between them regressed a route that was already here.
 *
 *   328  at `ccb90c45d`, pre-merge
 *   +33  the merged modules' own unscoped collection reads
 *    -2  `GET /surveys/:surveyId/builder` and `GET /surveys/:surveyId/logic`, REPAIRED in this
 *        pass rather than listed — they were a real disclosure, not an inventory entry
 *   -20  routes that left the finding set: the five `crm:autonomy:*` reads, four `crm:deals:read`
 *        and four `crm:leads:view` aggregates, `GET /contacts/duplicates`,
 *        `GET /clients/:clientId/activities`, `GET /settings/permissions`,
 *        `GET /build/:projectId/labels`, `GET /payroll/runs/:runId/approvals`, and the two
 *        `accounting:journal:read` reads that went with main's `finance/` module
 *   = 339
 *
 * RAISING a ratchet is the move this file's own rules are suspicious of, so the 31 routes it is
 * being raised to cover are named below and asserted individually. The number can then only hide
 * a route that is already written down. It is still a ratchet and it still must fall.
 *
 * NOT AUDITED, and this is the honest limit of this pass: of those 31, `inventory:*`,
 * `crm:deals:read`, `kb:articles:view`, `timesheets:entries:view` and `surveys:view` are all
 * `scopable` keys, so any one of them could be a disclosure of the `/deals/export` shape. Only
 * the two survey content reads were read end-to-end and repaired. The rest are recorded as
 * inventory — which is what this ratchet has always been — not as a judgement that they are safe.
 */
/**
 * 339 -> 336, 2026-09-12. Two repairs and one correction to the detector itself:
 *
 *   -2  `GET /timesheets/payroll/exports` and `GET /timesheets/payroll/exports/:exportId/rows`,
 *       REPAIRED — see `FIXED: a payroll export is read only at the scope that covers it` below.
 *   -1  `GET /timesheets/periods`, which was always scoped. The source index merged every class
 *       of one name into one bucket, first file winning per method, so the timesheets
 *       controller's `PeriodsService.listPeriods` was read as accounting's fiscal-period list and
 *       `ExceptionsService.listExceptions` as payroll's. The detector now follows the caller's
 *       own import (`resolveImportedClassMethods`), and the timesheets exceptions service is
 *       named for its entity, as its controller already was.
 */
const UNSCOPED_ROUTE_BASELINE = 293;

const notScopable = (key: string): string =>
  `${key} is not scopable: the catalog syncs it to permission_supported_scopes only at all and no seeded role narrows it, so no sibling withholds a row this read returns`;

const ADMITTED_KEYS_SINCE_BASELINE: ReadonlyMap<string, string> = new Map([
  ["hr:requisitions:view", `${notScopable("hr:requisitions:view")}; the recruitment reads moved here from hr:employees:view`],
  ["hr:templates:view", notScopable("hr:templates:view")],
  ["hr:attendance:manage", "its only unscoped read is GET /hr/biometric/devices, the org's device configuration with no person row"],
]);

const ADMITTED_SINCE_BASELINE: ReadonlyArray<readonly [string, string]> = [
  ["GET /agent/v1/projects/:projectId/tickets", "build:tickets:view is not scopable, and the read binds the project through ProjectAccessCache and spends the ticket DataScope through ticketScope like GET /build/:projectId/tickets"],
  ["GET /build/:projectId/import-export/tickets/export", "build:tickets:view is not scopable, and the export spends ticketScope; its silent-subset ticketIds defect is held open by bola-bulk-mixed-tenant"],
  ["GET /build/:projectId/tickets", "build:tickets:view is not scopable, and the list binds the project through ProjectAccessCache and spends ticketScope"],
  ["GET /build/:projectId/tickets/column-counts", "build:tickets:view is not scopable, and the count binds the project through ProjectAccessCache and spends ticketScope"],
  ["GET /build/:projectId/tickets/export", "build:tickets:view is not scopable, and the export spends ticketScope; its silent-subset ticketIds defect is held open by bola-bulk-mixed-tenant"],
  ["GET /build/:projectId/workload/capacity", "build:tickets:view is not scopable, and WorkloadCapacityService.capacity calls assertProjectVisible first"],
  ["GET /build/:projectId/activity", "build:view is not scopable, and the read narrows to readableTickets under ticketScope"],
  ["GET /build/:projectId/automations/runs", "build:view is not scopable, and the service calls assertProjectAccess before reading"],
  ["GET /build/:projectId/invoice-line-detail", "build:view is not scopable, and the service calls assertProjectAccess before reading"],
  ["GET /build/:projectId/labels", "build:view is not scopable, and the service calls assertProjectAccess before reading"],
  ["GET /build/:projectId/settings/iterations", "build:view is not scopable, and ProjectsSettingsIterationsService.getSettings calls assertProjectVisible first"],
  ["GET /build/:projectId/settings/retention", "build:view is not scopable, and ProjectsRetentionSettingsService.getSettings calls assertProjectVisible first"],
  ["GET /build/org-custom-states", "build:view is not scopable, and the read returns only the org's custom workflow state names, colours and types grouped across projects, with no project id, ticket or person"],
  ["GET /dashboard/crm-pulse", "crm:leads:view at own still sees four org-level KPI aggregates (MRR, pipeline value, new leads this week, conversion rate) and no lead or deal row; the section is registered with cacheScope org by design, so narrowing it is a product decision, not a row leak"],
  ["GET /hr/biometric/devices", "hr:attendance:manage: the read returns the org's biometric device configuration (name, address, vendor, sync state) and no attendance or person row"],
  ["GET /hr/reporting-lines/manager-candidates", "hr:employees:view: a manager picker returning name, email and designation of active members, the people the self-service directory:people:view directory already shows every member at all"],
  ["GET /hr/reporting-manager-policy", "hr:employees:view: the org's reporting-manager policy settings and the one configured default manager, no employee list"],
  ["GET /hr/recruitment/analytics", notScopable("hr:requisitions:view")],
  ["GET /hr/recruitment/analytics/funnel.csv", notScopable("hr:requisitions:view")],
  ["GET /hr/recruitment/automations", notScopable("hr:requisitions:view")],
  ["GET /hr/recruitment/candidates", notScopable("hr:requisitions:view")],
  ["GET /hr/recruitment/candidates/:candidateId/activity", notScopable("hr:requisitions:view")],
  ["GET /hr/recruitment/candidates/:candidateId/assessments", notScopable("hr:requisitions:view")],
  ["GET /hr/recruitment/candidates/:candidateId/bgv", notScopable("hr:requisitions:view")],
  ["GET /hr/recruitment/candidates/:candidateId/calibration", notScopable("hr:requisitions:view")],
  ["GET /hr/recruitment/candidates/:candidateId/documents", notScopable("hr:requisitions:view")],
  ["GET /hr/recruitment/candidates/:candidateId/documents/:documentId/view", notScopable("hr:requisitions:view")],
  ["GET /hr/recruitment/candidates/:candidateId/identity", notScopable("hr:requisitions:view")],
  ["GET /hr/recruitment/candidates/:candidateId/reference-checks", notScopable("hr:requisitions:view")],
  ["GET /hr/recruitment/candidates/:candidateId/referral", notScopable("hr:requisitions:view")],
  ["GET /hr/recruitment/candidates/:candidateId/rollout-documents", notScopable("hr:requisitions:view")],
  ["GET /hr/recruitment/candidates/:candidateId/sla", notScopable("hr:requisitions:view")],
  ["GET /hr/recruitment/candidates/:candidateId/voice-screens", notScopable("hr:requisitions:view")],
  ["GET /hr/recruitment/candidates/:candidateId/whatsapp", notScopable("hr:requisitions:view")],
  ["GET /hr/recruitment/candidates/duplicates", notScopable("hr:requisitions:view")],
  ["GET /hr/recruitment/email-sequences", notScopable("hr:requisitions:view")],
  ["GET /hr/recruitment/email-sequences/:sequenceId/metrics", notScopable("hr:requisitions:view")],
  ["GET /hr/recruitment/external-referrals", notScopable("hr:requisitions:view")],
  ["GET /hr/recruitment/external-referrers", notScopable("hr:requisitions:view")],
  ["GET /hr/recruitment/internal-jobs", notScopable("hr:requisitions:view")],
  ["GET /hr/recruitment/jobs", notScopable("hr:requisitions:view")],
  ["GET /hr/recruitment/jobs/:jobId/board-postings", notScopable("hr:requisitions:view")],
  ["GET /hr/recruitment/jobs/:jobId/recruiters", notScopable("hr:requisitions:view")],
  ["GET /hr/recruitment/jobs/:jobId/share", notScopable("hr:requisitions:view")],
  ["GET /hr/recruitment/job-templates", notScopable("hr:requisitions:view")],
  ["GET /hr/recruitment/messages", notScopable("hr:requisitions:view")],
  ["GET /hr/recruitment/messages/threads", notScopable("hr:requisitions:view")],
  ["GET /hr/recruitment/pipeline", notScopable("hr:requisitions:view")],
  ["GET /hr/recruitment/recruiters", notScopable("hr:requisitions:view")],
  ["GET /hr/recruitment/recruiters/activity", notScopable("hr:requisitions:view")],
  ["GET /hr/recruitment/requisitions", notScopable("hr:requisitions:view")],
  ["GET /hr/recruitment/sourcing/profiles/lookup", notScopable("hr:requisitions:view")],
  ["GET /hr/recruitment/talent-pools", notScopable("hr:requisitions:view")],
  ["GET /hr/recruitment/talent-pools/:poolId/members", notScopable("hr:requisitions:view")],
  ["GET /hr/recruitment/vendors", notScopable("hr:requisitions:view")],
  ["GET /hr/recruitment/diversity-report", notScopable("hr:sensitive:view")],
  ["GET /hr/templates", notScopable("hr:templates:view")],
  ["GET /hr/templates/variables", notScopable("hr:templates:view")],
  ["GET /timesheets/billing/uninvoiced-entries", notScopable("timesheets:billing:view")],
  ["GET /timesheets/periods/:periodId/approver", "timesheets:entries:view: previewApprover reads the period through ownedPeriodEntries, which refuses any period whose userMembershipId is not the caller's"],
];

const OPEN_SINCE_BASELINE: ReadonlyArray<readonly [string, string]> = [
  ["GET /build/releases", "build:view: ProjectsReleasesService.listOrgReleases returns every release in the org with its creator's email and never asserts project visibility, while GET /build/:projectId/releases calls assertProjectAccess; owned by the Build lane"],
];


/**
 * The 31 unscoped collection reads the merge brought, pinned by name so raising the baseline
 * cannot absorb a thirty-second. `sign:admin:manage` is NOT scopable (every holder resolves
 * `all`), so its three admin-config reads are inventory only; the others are listed because
 * their keys are scopable and the question about them is open.
 */
const NEWLY_VISIBLE_ON_THE_MERGE: readonly string[] = [
  "GET /crm/consent/contacts/:contactId/events",
  "GET /deals/:dealId/competitor-suggestions",
  "GET /hr/work-logs/export",
  "GET /inventory/channels/pools/availability",
  "GET /inventory/channels/pools/by-variant",
  "GET /inventory/handling-units",
  "GET /inventory/kits/:kitVariantId/bom",
  "GET /inventory/kits/buildable",
  "GET /inventory/ops/attention",
  "GET /inventory/ops/summary",
  "GET /inventory/ops/zones",
  "GET /inventory/ownership/consigned",
  "GET /inventory/picking/waves",
  "GET /inventory/products/pharmacy/h1-register",
  "GET /inventory/products/variants/:variantId/pharmacy",
  "GET /inventory/products/variants/:variantId/quantity-capture",
  "GET /inventory/products/variants/:variantId/receipt-requirements",
  "GET /inventory/products/variants/:variantId/tax-treatment",
  "GET /inventory/putaway/tasks",
  "GET /inventory/quick-commerce/asns",
  "GET /inventory/settings/packs",
  "GET /inventory/slotting/recommendations",
  "GET /inventory/stock/transit/stranded",
  "GET /inventory/traceability/genealogy",
  "GET /inventory/warehouses/putaway/suggestions",
  "GET /kb/articles/:articleId/indexing-status",
  "GET /sign/admin/settings",
  "GET /sign/admin/sweep-status",
  "GET /sign/admin/watermark-policies",
  "GET /surveys/templates",
  "GET /timesheets/calendar/holidays",
];

/**
 * Hand-verified disclosures — the unscoped route returned the same entity's rows
 * as its scoped sibling under the same key, so an `own`-scoped holder read the
 * whole organization. All six are now fixed, and each is asserted below as
 * scoped rather than pinned as open: a defect pin cannot go green and stay
 * honest, so once the finding is repaired the assertion has to be inverted into
 * a regression guard or it fails forever.
 *
 * `GET /deals/aging`, `/clients/export`, `/leads/export` and `/contacts/export`
 * are CRM, which is out of scope for this release. They are asserted here rather
 * than changed — the fix predates the exclusion, and dropping the assertion would
 * lose the finding.
 */
const FIXED_DISCLOSURES: ReadonlyMap<string, { key: string; sibling: string }> = new Map([
  ["GET /deals/aging", { key: "crm:deals:read", sibling: "GET /deals" }],
  ["GET /clients/export", { key: "crm:clients:read", sibling: "GET /clients" }],
  ["GET /leads/export", { key: "crm:leads:view", sibling: "GET /leads" }],
  ["GET /contacts/export", { key: "crm:contacts:view", sibling: "GET /contacts" }],
  ["GET /kb/search", { key: "kb:articles:view", sibling: "GET /kb/articles" }],
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
      .filter((k) => !DRIFTING_KEYS.includes(k) && !ADMITTED_KEYS_SINCE_BASELINE.has(k));
    expect(unexpected).toEqual([]);
  });

  it("RATCHET: the drifting route count, less the routes admitted since c675b7ad9 by name with a reason, does not grow past 293 (the 336 baseline less the 43 routes that left since), so the open Build site keeps it red until it is fixed", () => {
    const admitted = new Set(ADMITTED_SINCE_BASELINE.map(([route]) => route));
    const counted = findings.flatMap((f) => f.unscoped).filter((route) => !admitted.has(route));
    expect({ count: counted.length, open: OPEN_SINCE_BASELINE.filter(([route]) => counted.includes(route)) }).toEqual({
      count: Math.min(counted.length, UNSCOPED_ROUTE_BASELINE),
      open: [],
    });
  });

  it("every route and key admitted since the baseline is still flagged, so an excuse cannot outlive the read it excuses", () => {
    const unscoped = new Set(findings.flatMap((f) => f.unscoped));
    expect(ADMITTED_SINCE_BASELINE.map(([route]) => route).filter((route) => !unscoped.has(route))).toEqual([]);
    const keys = new Set(findings.map((f) => f.permissionKey));
    expect([...ADMITTED_KEYS_SINCE_BASELINE.keys()].filter((key) => !keys.has(key))).toEqual([]);
  });

  it("FIXED: GET /payroll/readiness names other employees' pending periods, so it is refused below scope all like its scoped run siblings", () => {
    const handler = loadRouteSurface().find((r) => r.verb === "GET" && r.path === "/payroll/readiness");
    expect(handler).toBeDefined();
    expect(handler && handlerScopeEvidence(handler, buildSourceIndex())).toBe(true);
    expect(handler?.body).toContain("if (!read.unrestricted) throw new NotFoundException");
    expect(findings.flatMap((f) => f.unscoped)).not.toContain("GET /payroll/readiness");
    expect(findings.find((f) => f.permissionKey === "payroll:runs:view")?.scoped).toContain("GET /payroll/readiness");
  });

  /**
   * The raise, held open. Every route the baseline was moved to cover is named, so the number
   * cannot quietly come to mean a different set of routes than the one it was raised for.
   * A route that gets FIXED leaves this list and lowers the baseline — that is the intended
   * direction, and it fails here first so the removal is deliberate.
   */
  it("RAISE: every route the baseline was raised for is still one of the routes it names", () => {
    const unscoped = new Set(findings.flatMap((f) => f.unscoped));
    const gone = NEWLY_VISIBLE_ON_THE_MERGE.filter((route) => !unscoped.has(route));
    expect(gone).toEqual([]);
  });

  /**
   * REPAIRED, and the pin holds the repair rather than the defect.
   *
   * `surveys:view` is `scopable: true`, `GET /surveys` and `GET /surveys/:surveyId` narrow to what
   * the caller created — and `GET /surveys/:surveyId/builder` and `.../logic` did not. So a holder
   * narrowed to `own` was refused the survey by its detail read and handed its sections,
   * questions, choices and branching rules through its children, under the same key. Both now
   * resolve the survey through `assertSurveyReadable` with the request's `ScopedRead`, and answer
   * a survey their scope excludes exactly as they answer one that does not exist.
   *
   * The residue is asserted as an exact set, not a subset: `GET /surveys/templates` reads no table
   * (`SurveyTemplateService.list()` returns a hard-coded array), so it is the one route
   * `surveys:view` may still have here, and a third would fail.
   */
  it("FIXED: the survey's content reads narrow like the survey itself", () => {
    const index = buildSourceIndex();
    const surface = loadRouteSurface();
    for (const path of ["/surveys/:surveyId/builder", "/surveys/:surveyId/logic"]) {
      const handler = surface.find((r) => r.verb === "GET" && r.path === path);
      expect(handler).toBeDefined();
      expect(handler && handlerScopeEvidence(handler, index)).toBe(true);
    }

    const surveys = findings.find((f) => f.permissionKey === "surveys:view");
    expect(surveys?.scoped).toEqual(
      expect.arrayContaining([
        "GET /surveys",
        "GET /surveys/:surveyId",
        "GET /surveys/:surveyId/builder",
        "GET /surveys/:surveyId/logic",
      ]),
    );
    expect(surveys?.unscoped).toEqual(["GET /surveys/templates"]);
  });

  it("FIXED: GET /deals/export applies the same scope as GET /deals", () => {
    const deals = findings.find((f) => f.permissionKey === "crm:deals:read");
    expect(deals?.scoped).toContain("GET /deals");
    expect(deals?.scoped).toContain("GET /deals/export");
    expect(deals?.unscoped).not.toContain("GET /deals/export");
  });

  /**
   * Asked of the detector directly rather than of `findings`, because a key drops
   * out of `findings` entirely once EVERY one of its reads scopes — which is the
   * best outcome, and which the previous form of this test read as a failure.
   * `sign:envelope:view` reached that state when the fields and recipients lists
   * were bound, so requiring the key to still be drifting would now punish the fix.
   */
  it("FIXED: every hand-verified disclosure now resolves a scope, like its sibling", () => {
    const index = buildSourceIndex();
    const surface = loadRouteSurface();
    const stillDrifting: string[] = [];
    for (const [route, { sibling }] of FIXED_DISCLOSURES) {
      for (const target of [route, sibling]) {
        const [verb, path] = target.split(" ");
        const handler = surface.find((r) => r.verb === verb && r.path === path);
        expect(handler).toBeDefined();
        if (handler && !handlerScopeEvidence(handler, index)) stillDrifting.push(target);
      }
    }
    expect(stillDrifting).toEqual([]);
  });

  /**
   * `sign:envelope:view` was on the drifting list because
   * `GET /sign/envelopes/:envelopeId/fields` and `.../recipients` returned their
   * rows under `(orgId, envelopeId)` alone. Both now resolve the envelope through
   * `mustGetVisibleEnvelope`, so the key has no unscoped read left and has left
   * the finding set — asserted here so its removal from DRIFTING_KEYS is a
   * measured fact rather than an unexplained deletion.
   */
  /**
   * REPAIRED. `timesheets:payroll:view` is `scopable: true` and a timesheets module member holds
   * it at `own`. `GET /timesheets/payroll/period-summary` narrowed to that member's own rows;
   * the export history and the rows behind an export — every payee's hours, name and email in
   * one snapshot — read the whole organisation under the same key. An export belongs to nobody
   * in particular, so below `all` there is none to read: the list is empty and the rows are 404.
   */
  it("FIXED: a payroll export is read only at the scope that covers it", () => {
    const unscoped = new Set(findings.flatMap((f) => f.unscoped));
    expect(unscoped.has("GET /timesheets/payroll/exports")).toBe(false);
    expect(unscoped.has("GET /timesheets/payroll/exports/:exportId/rows")).toBe(false);
    const payroll = findings.find((f) => f.permissionKey === "timesheets:payroll:view");
    expect(payroll?.scoped).toEqual(
      expect.arrayContaining(["GET /timesheets/payroll/exports", "GET /timesheets/payroll/exports/:exportId/rows"]),
    );
  });

  it("FIXED: sign:envelope:view has no unscoped read left at all", () => {
    expect(findings.map((f) => f.permissionKey)).not.toContain("sign:envelope:view");
    const index = buildSourceIndex();
    const surface = loadRouteSurface();
    for (const path of [
      "/sign/envelopes/:envelopeId/fields",
      "/sign/envelopes/:envelopeId/recipients",
      "/sign/envelopes/:envelopeId/documents",
      "/sign/documents/:documentId/preview",
    ]) {
      const handler = surface.find((r) => r.verb === "GET" && r.path === path);
      expect(handler).toBeDefined();
      expect(handler && handlerScopeEvidence(handler, index)).toBe(true);
    }
  });

  /**
   * Fixing `GET /tasks` and `GET /timesheets/billing/rate-preview` made their
   * keys visible to a detector that needs one scoped and one unscoped handler:
   * before the fix NEITHER side scoped, so the key did not qualify. Both
   * remaining siblings are the benign shape the detector's own comment names —
   * `GET /tasks/sequences` lists org-level sequence templates and
   * `GET /timesheets/billing/uninvoiced` is the org's billing queue.
   */
  it("EXPECTED-CONSEQUENCE: a key becomes visible when one of its siblings starts scoping, and the non-scopable billing queue now carries its entries read beside it", () => {
    const tasks = findings.find((f) => f.permissionKey === "tasks:read");
    expect(tasks?.scoped).toContain("GET /tasks");
    expect(tasks?.unscoped).toEqual(["GET /tasks/sequences"]);

    const billing = findings.find((f) => f.permissionKey === "timesheets:billing:view");
    expect(billing?.scoped).toContain("GET /timesheets/billing/rate-preview");
    expect(billing?.unscoped).toEqual(["GET /timesheets/billing/uninvoiced", "GET /timesheets/billing/uninvoiced-entries"]);

    /**
     * Same shape, from the certificate/audit fix: `GET /sign/envelopes/:envelopeId/audit`
     * started resolving `sign:envelope:view`, which made `sign:audit:view` visible.
     * There is no escalation behind it — `sign:audit:view` is NOT scopable, so every
     * holder resolves "all" for it and `GET /sign/reports/summary` is the org-wide
     * analytics aggregate that key exists to authorise.
     */
    const signAudit = findings.find((f) => f.permissionKey === "sign:audit:view");
    expect(signAudit?.scoped).toContain("GET /sign/envelopes/:envelopeId/audit");
    expect(signAudit?.unscoped).toEqual(["GET /sign/reports/summary"]);
  });
});
