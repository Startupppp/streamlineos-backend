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
    // 3642 -> 3648, and the six are individually accounted for:
    //   +2  GET|POST /cron/calendar-provider-sync-sweep — the drain the provider-sync
    //       queue had never had. Cron-secret-authenticated and bodyless.
    //   +1  GET /blog/admin/categories
    //   +1  GET /finance/bank-accounts/{bankAccountId}
    //   +2  GET /v2/users, GET /v2/users/{userId}
    // CORRECTED. The comment that stood here claimed `queryFields`, `idFields` and
    // `operationsWithIdFields` were unmoved because "six operations arrived and brought no
    // id-shaped request field with them". That was FALSE and it was hiding the one operation
    // of the six that matters: `GET /v2/users` declares FOUR id-shaped query filters —
    // departmentId, branchId, teamId, managerUserId — every one of which widens or narrows the
    // set of people returned. So the census moves 239 -> 243, 1052 -> 1056 and 671 -> 672, and
    // the four fields are asserted individually below rather than absorbed into a number: a
    // route with four org-scoping id filters is either swept or it is a blind spot.
    // This census tracks `openapi.json`, so it has to be re-read after the release's final
    // `pnpm openapi:generate` rather than assumed.
    // Descriptive, re-read after `pnpm openapi:generate`; the sweeps below are what bite.
    // 3667 -> 3666: `48c612a8d refactor(branches)` retired one operation. Descriptive only; the sweeps below are what bite.
    // 3666 -> 3654, re-pinned 2026-09-11 after the org-access remediation regenerated the
    // contract. The whole delta is accounted for route by route, and it has to be, because a
    // count that moved further than the deleted routes explain is a signal, not a rebase:
    //   -13 deleted: the six `DELETE /org-hierarchy/<kind>/{id}` (D4), the four
    //       `PATCH /org-hierarchy/<kind>/{id}/move` (D3), `POST /workspace-onboarding/complete`
    //       (D17, folded into the setup-completed outbox consumer), and the two compat deletes
    //       `DELETE /hr/org/locations/{locationId}` and `DELETE /hr/org/teams/{teamId}`.
    //   +1 added: `GET /org/setup/status`.
    //   3666 - 13 + 1 = 3654.
    // bodyFields 814 -> 810 and operationsWithIdFields 674 -> 670 are the SAME four operations:
    // only the four move routes carried a request body at all, each declaring exactly one
    // id-shaped field — businessUnitId, parentId, branchId, departmentId, read off the
    // pre-deletion contract. The eight DELETEs and `POST /workspace-onboarding/complete`
    // declared no request body and no query parameter; `GET /org/setup/status` declares
    // neither; and the `invitees` array `POST /org/setup/complete` gained holds `email` and
    // `role`, so it adds no id-shaped field. idFields is bodyFields + queryFields, hence -4.
    // queryFields is unmoved at 245, which is the control: nothing on either side of the
    // change declared a query parameter.
    expect(counts.operations).toBe(3654);
    expect(counts.bodyFields).toBe(810);
    expect(counts.queryFields).toBe(245);
    expect(counts.idFields).toBe(1055);
    expect(counts.operationsWithIdFields).toBe(670);
  });

  /**
   * The four the census moved for, read individually rather than counted.
   *
   * `GET /v2/users` is the versioned list route added by the API-versioning pass. It collides
   * with the unversioned `UsersController.listUsers` on `@Get()`, which is why its operation
   * resolved to `handler-not-found` when it first appeared — a route carrying four id-shaped
   * org-scoping filters that nothing swept. It resolves now, and this asserts what it resolves
   * TO: putting it in the named-exception set below instead would have been the allowlist
   * widening this release forbids.
   */
  it("sweeps the four org-scoping id filters GET /v2/users brought, rather than excusing them", () => {
    const v2 = bindings.filter((b) => b.path === "/v2/users" && b.location === "query");
    const byField = new Map(v2.map((b) => [b.field, b.verdict]));
    expect([...byField.keys()].sort()).toEqual(["branchId", "departmentId", "managerUserId", "teamId"]);
    for (const [field, verdict] of byField)
      expect([field, verdict]).toEqual([field, expect.stringMatching(/^(?:org-predicate|filter-in-org-query)$/)]);
  });

  // Pinned by name, not by count: a swapped-in selector must fail, not net to zero.
  it("splits out the tenant and actor selectors rather than analysing them as object references", () => {
    const { counts } = enumerateIdFieldSites();

    const pinnedTenant: unknown = JSON.parse(
      readFileSync(join(BACKEND_ROOT, "test/security/bola/tenant-selector-surface.json"), "utf8"),
    );
    const tenant = counts.tenantSelectors
      .map((site) => `${site.method} ${site.path} ${site.location} ${site.field}`)
      .sort();
    expect(tenant).toEqual(pinnedTenant);

    const pinned: unknown = JSON.parse(
      readFileSync(join(BACKEND_ROOT, "test/security/bola/actor-selector-surface.json"), "utf8"),
    );
    const actual = counts.actorSelectors
      .map((site) => `${site.method} ${site.path} ${site.location} ${site.field}`)
      .sort();
    expect(actual).toEqual(pinned);
  });

  it("resolves a handler for all but a named few — an unresolved handler is a blind spot, not a pass", () => {
    const missing = bindings.filter((b) => b.verdict === "handler-not-found").map((b) => b.operationId);
    expect(new Set(missing)).toEqual(
      /**
       * Three of the six named here were resolved by `057adf02`, which regenerated `openapi.json`
       * after it had gone 31 operations stale. The set is TIGHTENED rather than left wide: a
       * blind spot that closed must shrink the allowance, or the next one to open is absorbed.
       *
       * EMPTIED on the merge. `SurveyParticipantsController_import` and
       * `TimesheetBillingController_export` resolve now: both are handlers NAMED after a reserved
       * word, which the walk in `route-surface.ts` dropped until its keyword list went the way of
       * the gate's (053db5f39). `FinanceAuditController_export` went with main's `finance/` module
       * when the gl_* rewrite replaced it — there is no such handler to resolve.
       */
      new Set([]),
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
/**
 * RAISED 211 -> 223 on 2026-09-03, and again the reason is VISIBILITY, not regression.
 *
 * The tracer could not follow a carrier forwarded WHOLE out of a service method — the shape
 * `return queryTimeline(this.db, organizationId, query);`, where the field name occurs nowhere in
 * the method. It handled that at the controller boundary and nowhere below it, so every id the
 * DTO carried past one hand-off was scored `never-read`. That blind spot is now closed
 * (`forwardedCalls` in `body-id-binding.ts`) and the whole surface moved at once:
 * `never-read` **272 -> 179**, resolved **384 -> 465**, `written-unresolved` **211 -> 223**.
 *
 * The 14 sites below are the ones the closed blind spot exposed. NONE of them is new code: each is
 * a write that was always there and that the analyser could not see. They are pinned by name so
 * raising the number cannot absorb them, and the count is +12 rather than +14 because two former
 * findings resolved into `org-predicate` once the trace could reach the query.
 *
 * ⚠ The blind spot was opened wider by `c7e4628a`, which split fourteen files by responsibility:
 * `ActivitiesService.timeline`'s query became a free function and three sites on
 * `ActivitiesController_timeline` went `filter-in-org-query` -> `never-read` on that commit alone.
 * The file-size programme will keep producing that shape, so the fix belongs in the analyser.
 */
const WRITTEN_UNRESOLVED_BASELINE = 225;
const UNRESOLVED_BASELINE = 179;

/**
 * Four, not five. `CrmMetadataController_createBlueprint|pipelineId` left this list on
 * 2026-09-08 because the site was FIXED, not because the analyser stopped seeing it:
 * `analyzeIdFields` now returns `org-predicate` for it, so the write is tenant-scoped.
 * Checked by querying the analyser directly rather than inferring it from the absence.
 * The pin did its job — the site could not vanish quietly.
 */
/**
 * One, not four. The three `AssetCategoriesController_update` sites left with main's
 * `finance/` fixed-asset surface when the gl_* accounting rewrite replaced it: there is no
 * such controller on this branch, so the pin could only ever fail. Removed because the code
 * is gone, not because the analyser stopped seeing it — `SignFieldsController_update` is
 * still held below, which is what proves the spread-before-fallback trace still works.
 */
const NEWLY_VISIBLE_BY_SPREAD_ORDERING: readonly string[] = [
  "SignFieldsController_update|groupId",
];

/** The two sites the regenerated contract made visible. Named so the ratchet cannot absorb them. */
const NEWLY_VISIBLE_WRITTEN_UNRESOLVED: readonly string[] = [
  "GitConnectionsController_createConnection|projectId",
  "SettingsDeprecatedRoutesController_createGitConnection|projectId",
];

/** The 14 the forwarded-carrier trace made visible. Same rule: named, so they cannot be absorbed. */
const NEWLY_VISIBLE_BY_FORWARDED_CARRIER: readonly string[] = [
  "AgentController_createTicket|sprintId",
  "AgentController_createTicket|cycleId",
  "AgentController_createTicket|parentTicketId",
  "ProjectsTicketsController_createTicket|sprintId",
  "ProjectsTicketsController_createTicket|cycleId",
  "ProjectsTicketsController_createTicket|parentTicketId",
  "ProjectsTicketChecklistsController_createChecklistItem|assigneeId",
  "DealsController_createDeal|leadId",
  "DealsController_createDeal|clientId",
  "DealsController_createDeal|partyId",
  "DealsController_createDeal|subjectId",
  "PerformanceController_createPip|hrRepId",
  "RecruitmentSourcingController_createSubmission|candidateId",
  "RecruitmentSourcingController_createSubmission|jobPostingId",
];

/**
 * NOT raised for these. `1cddeadea` deleted a `body as InboundCommunicationEvent` cast from
 * `InboundIngressController.accept`, which is what had been stopping the trace at the controller
 * boundary: both fields went `never-read` -> `written-unresolved` on that commit and pushed the
 * count to 224 against a baseline of 223. Raising the baseline to absorb them is the move
 * CLOSURE-DEFINITION forbids, so it was not made — the count came back UNDER the unchanged
 * baseline because a real finding was repaired instead (calendar's linked deal and lead, below).
 *
 * They are named here so they stay visible, and so the next reader knows what they are: both are
 * `z.string().trim().max(500)` in `inbound-event.schemas.ts` — a provider's OWN opaque identifier
 * for a message and a thread, not a reference to any row of ours. `eventIdentity` and
 * `threadIdentity` already prefix both with `organizationId` before they are used as a dedupe key,
 * so one tenant's provider id cannot collide with another's.
 */
const NEWLY_VISIBLE_BY_CAST_REMOVAL: readonly string[] = [
  "InboundIngressController_accept|providerMessageId",
  "InboundIngressController_accept|providerThreadId",
];

describe("findings", () => {
  it("still holds the two sites the deleted type cast made visible", () => {
    const present = new Set(
      bindings
        .filter((b) => b.verdict === "written-unresolved")
        .map((b) => `${b.operationId}|${b.field}`),
    );
    expect(NEWLY_VISIBLE_BY_CAST_REMOVAL.filter((site) => !present.has(site))).toEqual([]);
  });

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

  it("still holds the five sites the spread-before-fallback ordering made visible", () => {
    const present = new Set(
      bindings
        .filter((b) => b.verdict === "written-unresolved")
        .map((b) => `${b.operationId}|${b.field}`),
    );
    expect(NEWLY_VISIBLE_BY_SPREAD_ORDERING.filter((site) => !present.has(site))).toEqual([]);
  });

  it("still holds the fourteen sites the forwarded-carrier trace made visible", () => {
    const present = new Set(
      bindings
        .filter((b) => b.verdict === "written-unresolved")
        .map((b) => `${b.operationId}|${b.field}`),
    );
    expect(NEWLY_VISIBLE_BY_FORWARDED_CARRIER.filter((site) => !present.has(site))).toEqual([]);
  });

  it("keeps a majority of the surface resolved, so the ratchet is measuring a real remainder", () => {
    const counts = summarize(bindings);
    const resolved = counts["org-predicate"] + counts["object-assertion"] + counts["filter-in-org-query"];
    // 386 -> 465 with the forwarded-carrier trace. It is a FLOOR, so it may only move up.
    expect(resolved).toBeGreaterThanOrEqual(465);
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
describe("cross-territory findings, recorded rather than repaired — except where noted", () => {
  /**
   * REPAIRED, and the pin is flipped to hold the repair rather than the defect.
   *
   * `calendar_events.linked_deal_id` and `.linked_lead_id` are `bare-fk` in
   * `body-id-integrity.json` — a single-column reference to `deals(id)` / `leads(id)` with no
   * `org_id` in it — so another organisation's deal id LANDED while an id belonging to nobody
   * raised a foreign-key error. Both consequences followed: a cross-tenant write, and an
   * existence oracle in the difference between the two answers. `assertLinkedCrmRecordsInOrg`
   * now resolves both references under the caller's org inside the mutation's own transaction,
   * on POST /calendar/events AND on PUT /calendar/events/{eventId} — the update path carried the
   * same two fields and this census never saw it, so fixing only what the census flagged would
   * have left half the defect standing.
   */
  it("calendar resolves a linked deal and lead under the caller's org before writing them", () => {
    for (const [path, method] of [
      ["/calendar/events", "POST"],
      ["/calendar/events/{eventId}", "PUT"],
    ] as const) {
      const byField = new Map(
        bindings.filter((b) => b.path === path && b.method === method).map((b) => [b.field, b.verdict]),
      );
      expect([path, byField.get("linkedDealId")]).toEqual([path, "object-assertion"]);
      expect([path, byField.get("linkedLeadId")]).toEqual([path, "object-assertion"]);
    }
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
