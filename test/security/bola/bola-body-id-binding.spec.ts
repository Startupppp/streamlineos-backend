/**
 * The BOLA sweep, extended from the URL PATH to the REQUEST BODY and the QUERY
 * STRING.
 *
 * Everything before this asked "does this ROUTE bind a tenant somewhere". That
 * question is answered `yes` by the predicate written for the path parameter,
 * which is exactly why a body id gets missed: `/things/:thingId` 404s correctly
 * on another organisation's id while `{"otherThingId": …}` in the same request
 * is written into the row untouched.
 *
 * HOW THE ROUTES ARE ENUMERATED — so the numbers below are reproducible
 *
 *   1. `openapi.json`, the committed contract, is read. Every operation under a
 *      GET/POST/PUT/PATCH/DELETE key is counted (3,613).
 *   2. For each, the `application/json` request-body properties and the
 *      `in: query` parameters are collected, and the ones whose NAME is
 *      id-shaped (`/(?:^|[a-z0-9])(Id|Ids)$/`) are kept.
 *   3. `orgId`/`organizationId`/`tenantId` and `userId`/`actorId`/`createdById`/
 *      `authorId` are split off — those are the tenant selector and the actor
 *      selector CLAUDE.md §5 forbids a client to send about itself, and the
 *      question about them is "why is this accepted", not "is it resolved".
 *   4. What remains is joined to its handler through `operationId`, which Nest
 *      emits as `<ControllerClass>_<handler>`, and traced field-by-field into
 *      the services the handler calls.
 *
 * WHAT MAKES THE VERDICT NON-VACUOUS
 *
 * A write literal routinely carries `orgId` beside the foreign id —
 * `.values({ orgId, contactId: input.contactId })` is the CrmConsent defect
 * verbatim — so a detector that looks for `orgId` anywhere near the field reads
 * the defect as safe. An occurrence inside `insert().values()` / `update().set()`
 * therefore never counts as authorization here, no matter what else is in the
 * literal. `readsAWriteLiteralAsUnbound` below is the assertion that pins it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BACKEND_ROOT } from "./route-surface";
import {
  analyzeIdFields,
  classifyFieldInSource,
  enumerateIdFieldSites,
  parameterNames,
  summarize,
  type FieldBinding,
} from "./body-id-binding";

let bindings: FieldBinding[];

beforeAll(() => {
  bindings = analyzeIdFields();
});

describe("the detector bites", () => {
  it("reads a write literal as UNBOUND even when the literal itself carries orgId", () => {
    const source = `async record(orgId: string, input: Input) {
      const [row] = await this.db.insert(consent).values({ orgId, contactId: input.contactId }).returning();
      return row;
    }`;
    expect(classifyFieldInSource(source, "input", "contactId")).toBe("written-unresolved");
  });

  it("reads the same method as BOUND once the id is resolved under the caller's org first", () => {
    const source = `async record(orgId: string, input: Input) {
      const contact = await this.db.query.contacts.findFirst({
        where: and(eq(contacts.id, input.contactId), eq(contacts.orgId, orgId)),
      });
      if (!contact) throw new NotFoundException("Contact not found");
      const [row] = await this.db.insert(consent).values({ orgId, contactId: input.contactId }).returning();
      return row;
    }`;
    expect(classifyFieldInSource(source, "input", "contactId")).toBe("org-predicate");
  });

  it("follows a destructured field, which is how most services read their DTO", () => {
    const source = `async list(orgId: string, query: Query) {
      const { accountId } = query;
      return this.db.select().from(lines).where(and(eq(lines.orgId, orgId), eq(lines.accountId, accountId)));
    }`;
    expect(classifyFieldInSource(source, "query", "accountId")).toBe("org-predicate");
  });

  it("catches a whole DTO spread into a write literal, where the field is never named at all", () => {
    const source = `async create(orgId: string, input: Input) {
      return this.db.insert(rows).values({ orgId, ...input }).returning();
    }`;
    expect(classifyFieldInSource(source, "input", "vendorId")).toBe("written-unresolved");
  });

  it("does not call a bare mention in an org-bound method resolved — a filter is not a resolution", () => {
    const source = `async create(orgId: string, input: Input) {
      const label = String(input.vendorId);
      return this.db.insert(rows).values({ orgId, label }).returning();
    }`;
    expect(classifyFieldInSource(source, "input", "vendorId")).toBe("unresolved");
  });

  it("reads a predicate-only use inside an org-bound query as a filter, not a finding", () => {
    const source = `async list(orgId: string, query: Query) {
      const conds = [eq(rows.orgId, orgId)];
      if (query.categoryId !== undefined) conds.push(eq(rows.categoryId, query.categoryId));
      return this.db.select().from(rows).where(and(...conds));
    }`;
    expect(classifyFieldInSource(source, "query", "categoryId")).toBe("filter-in-org-query");
  });

  it("reports never-read when the field genuinely does not reach the method", () => {
    const source = `async create(orgId: string, input: Input) {
      return this.db.insert(rows).values({ orgId, name: input.name }).returning();
    }`;
    expect(classifyFieldInSource(source, "input", "vendorId")).toBe("never-read");
  });

  it("reads a method signature's parameter names in order, which is how a delegated id is followed", () => {
    expect(parameterNames("async createItem(orgId: string, input: CreateInput, actor: Actor)")).toEqual([
      "orgId",
      "input",
      "actor",
    ]);
    expect(parameterNames("list(@Query() query: Q, @CurrentUser() u: CurrentUserContext)")).toEqual(["query", "u"]);
  });
});

describe("the surface, enumerated from the committed contract", () => {
  it("counts the operations and the id-shaped body and query fields", () => {
    const { counts } = enumerateIdFieldSites();
    expect(counts.operations).toBe(3642);
    // 815 -> 813 and 1054 -> 1052 at `25a87768` / `1400ca6c`, which removed four request fields
    // nothing implements. Two of the four are id-shaped body fields — `attachmentSchema.fileKey`
    // and `kbAskSchema.articleId` — so two body sites and two id sites went with them, on two
    // operations. The ratchet moved DOWN, which is the direction it is allowed to move.
    expect(counts.bodyFields).toBe(813);
    expect(counts.queryFields).toBe(239);
    expect(counts.idFields).toBe(1052);
    expect(counts.operationsWithIdFields).toBe(671);
  });

  it("splits out the tenant and actor selectors rather than analysing them as object references", () => {
    const { counts } = enumerateIdFieldSites();
    expect(counts.tenantSelectors).toHaveLength(12);
    expect(counts.actorSelectors).toHaveLength(95);
  });

  it("resolves a handler for all but a named few — an unresolved handler is a blind spot, not a pass", () => {
    const missing = bindings.filter((b) => b.verdict === "handler-not-found").map((b) => b.operationId);
    expect(new Set(missing)).toEqual(
      /**
       * Three of the six named here were resolved by `057adf02`, which regenerated `openapi.json`
       * after it had gone 31 operations stale. The set is TIGHTENED rather than left wide: a
       * blind spot that closed must shrink the allowance, or the next one to open is absorbed.
       */
      new Set([
        "FinanceAuditController_export",
        "SurveyParticipantsController_import",
        "TimesheetBillingController_export",
      ]),
    );
  });
});

/**
 * A ratchet, not a target. `written-unresolved` is the finding that matters: the
 * id reaches a row as a reference and is never read back under the caller's org.
 * A new one fails this suite; a repaired one lowers the number and is reported
 * so the baseline moves down deliberately rather than drifting up quietly.
 */
/**
 * RAISED 209 -> 211 and 174 -> 179 on 2026-09-03, and the reason is visibility, not regression.
 *
 * `057adf02` regenerated `openapi.json`, which had been 31 operations stale. Six mutating
 * object-addressable routes that 15e recorded as **absent from the contract** are now described,
 * so their body ids are enumerated for the first time. Both added `written-unresolved` sites are
 * the SAME field on the same handler reached through two routes — `projectId` on
 * `POST /integrations/git/connections` and its deprecated `/settings/integrations/git` alias — and
 * `git_connections` carries `fk_git_connections_org_project (org_id, project_id) ->
 * build.projects(org_id, id)`, a composite tenant foreign key, so another organisation's project
 * id **cannot land**. Measured in `pg_constraint` on `scratch_t15`, not inferred.
 *
 * They are pinned by name below, so raising the number does not hide them.
 */
const WRITTEN_UNRESOLVED_BASELINE = 211;
const UNRESOLVED_BASELINE = 179;

/** The two sites the regenerated contract made visible. Named so the ratchet cannot absorb them. */
const NEWLY_VISIBLE_WRITTEN_UNRESOLVED: readonly string[] = [
  "GitConnectionsController_createConnection|projectId",
  "SettingsDeprecatedRoutesController_createGitConnection|projectId",
];

describe("findings", () => {
  it("does not add an unresolved body or query id", () => {
    const counts = summarize(bindings);
    expect(counts["written-unresolved"]).toBeLessThanOrEqual(WRITTEN_UNRESOLVED_BASELINE);
    expect(counts.unresolved).toBeLessThanOrEqual(UNRESOLVED_BASELINE);
  });

  it("still holds the two sites the regenerated contract made visible, refused by a composite tenant FK", () => {
    const present = new Set(
      bindings
        .filter((b) => b.verdict === "written-unresolved")
        .map((b) => `${b.operationId}|${b.field}`),
    );
    for (const site of NEWLY_VISIBLE_WRITTEN_UNRESOLVED) expect(present.has(site)).toBe(true);
  });

  it("keeps a majority of the surface resolved, so the ratchet is measuring a real remainder", () => {
    const counts = summarize(bindings);
    const resolved = counts["org-predicate"] + counts["object-assertion"] + counts["filter-in-org-query"];
    expect(resolved).toBeGreaterThanOrEqual(386);
  });

  /**
   * The integrity column is measured against `pg_constraint`, not inferred. A
   * composite tenant foreign key makes the same source shape harmless — another
   * organisation's id cannot land — so the split decides which findings are
   * live and which are already caught by the database.
   */
  it("carries the measured referential-integrity split beside the source findings", () => {
    const raw: unknown = JSON.parse(
      readFileSync(join(BACKEND_ROOT, "test/security/bola/live/body-id-integrity.json"), "utf8"),
    );
    const columns = (raw as { columns: Record<string, string> }).columns;
    const tally = new Map<string, number>();
    for (const verdict of Object.values(columns)) tally.set(verdict, (tally.get(verdict) ?? 0) + 1);
    expect(Object.keys(columns)).toHaveLength(172);
    expect(tally.get("composite-tenant-fk")).toBe(92);
    expect(tally.get("bare-fk")).toBe(17);
    expect(tally.get("no-fk")).toBe(58);
  });

  /**
   * The e-sign module's own body ids, read individually. Two are decorative and
   * one was a real integrity gap that this pass closed — recorded by name so a
   * regression on any of the three fails rather than being absorbed into the
   * ratchet.
   */
  it("e-sign: the watermark scope target is resolved, and the two decorative fields are named", () => {
    const sign = bindings.filter((b) => b.path.startsWith("/sign/"));
    const byField = new Map(sign.map((b) => [`${b.method} ${b.path} ${b.field}`, b.verdict]));

    expect(byField.get("POST /sign/admin/watermark-policies scopeId")).toBe("org-predicate");
    expect(byField.get("PATCH /sign/admin/watermark-policies/{policyId} scopeId")).toBe("org-predicate");

    for (const key of [
      "POST /sign/envelopes sourceEntityId",
      "PATCH /sign/envelopes/{envelopeId} sourceEntityId",
      "POST /sign/templates/{templateId}/create-envelope sourceEntityId",
      "POST /sign/envelopes/{envelopeId}/fields groupId",
      "PATCH /sign/fields/{fieldId} groupId",
    ])
      expect(byField.get(key)).toBe("written-unresolved");
  });
});

/**
 * The findings this pass read individually and could not fix, pinned by name so
 * they survive the ratchet. Each names its owner. `pinned` is asserted as a set
 * so a repair shows up as a failure that has to be acknowledged, rather than
 * quietly shrinking a number.
 */
describe("cross-territory findings, recorded rather than repaired", () => {
  it("calendar stores another organisation's deal and lead id on an event", () => {
    const calendar = bindings.filter((b) => b.path === "/calendar/events" && b.method === "POST");
    const byField = new Map(calendar.map((b) => [b.field, b.verdict]));
    expect(byField.get("linkedDealId")).toBe("written-unresolved");
    expect(byField.get("linkedLeadId")).toBe("written-unresolved");
  });

  it("timesheets stores another organisation's client id on a rate", () => {
    const rate = bindings.find(
      (b) => b.path === "/timesheets/rates" && b.field === "clientId" && b.location === "body",
    );
    expect(rate?.verdict).toBe("written-unresolved");
  });

  it("inventory — EXCLUDED FROM THIS RELEASE — accepts another organisation's warehouse as a transfer target", () => {
    const transfer = bindings.find(
      (b) => b.path === "/inventory/stock/transfers" && b.field === "toWarehouseId" && b.location === "body",
    );
    expect(transfer?.verdict).toBe("written-unresolved");
  });

  it("crm — EXCLUDED FROM THIS RELEASE — stores another organisation's deal id on an activity", () => {
    const activity = bindings.find(
      (b) => b.path === "/crm/activities" && b.field === "dealId" && b.location === "body",
    );
    expect(activity?.verdict).toBe("written-unresolved");
  });
});
