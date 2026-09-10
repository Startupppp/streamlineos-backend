import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findBulkSites, classifyBulkMethod, parameterNames, derivedIdLocals } from "./bulk-id-handling";
import { BACKEND_ROOT } from "./route-surface";
import { buildSourceIndex } from "./tenant-binding";

/**
 * A bulk endpoint handed a mixed-tenant id list must fail the whole request.
 * `inArray(table.id, ids)` beside `eq(table.orgId, orgId)` is not isolation: it
 * silently narrows the work to the rows the caller owns and returns success, so
 * the caller believes every id was acted on and the response distinguishes
 * "not yours" from "already done".
 */

/**
 * The inventory is a FLOOR, not a cap.
 *
 * It used to be `sites.length <= 55`, which counted guarded sites too, so adding
 * a correct guard could trip the ratchet — a ratchet that punishes the fix is
 * not a ratchet. The defect count is `no-count-check`; that is what may not
 * grow. `sites.length` only guards against the scan quietly finding less.
 */
const BULK_SITE_FLOOR = 60;
const NO_COUNT_CHECK_BASELINE = 45;
const FAIL_WHOLE_FLOOR = 21;

/**
 * Confirmed silent-subset sites still open. `inArray(table.id, ids)` beside
 * `eq(table.orgId, orgId)` narrows the work to the rows the caller owns and
 * returns success, so the caller is told every id was acted on.
 *
 * CRM is out of scope for this release, so the two `DealsCrudService` entries
 * are recorded rather than repaired. The defect is unchanged: `bulkDelete` and
 * `bulkUpdate` on `POST /deals/bulk-*` accept a mixed-tenant `dealIds` list,
 * act on the caller's own deals and report success. The fix is the same count
 * check as everywhere else, and it belongs to whoever owns `modules/deals`.
 */
const CONFIRMED_SILENT_SUBSET: readonly string[] = [
  "DealsCrudService.bulkDelete",
  "DealsCrudService.bulkUpdate",
];

/**
 * Repaired in this pass. Each now fetches under the tenant predicate, compares
 * the row count against the requested id count, and throws `NotFoundException`
 * — 404, never 403 — for the WHOLE request on a mismatch.
 *
 * `bulkApprove` and `DataQualityResolutionService.resolve` are fixed at their
 * entry point rather than at the `inArray` site: both had a legitimate per-row
 * skip (not submitted / already decided) sharing one predicate with the tenant
 * filter, so a foreign id was indistinguishable from a skipped one. Tenant
 * membership is now asserted first and on its own, which is why they do not
 * appear in this list of detector-visible sites.
 */
const REPAIRED_FAIL_WHOLE: readonly string[] = [
  "NotificationsLifecycleService.bulkMarkRead",
  "NotificationsLifecycleService.bulkArchive",
  "NotificationsLifecycleService.bulkDelete",
  "RecruitmentCandidateOpsService.bulkReject",
  "RecruitmentCandidateOpsService.bulkShortlist",
  "RecruitmentAutomationService.enrollSequence",
  "SurveyParticipantService.invite",
  "SurveyParticipantService.remind",
  "KbTagsService.setArticleTags",
  "ApprovalsBulkService.bulkReject",
];

/**
 * Methods the scan reports as unguarded whose id list is derived inside the
 * caller from an already tenant-scoped query, so a mixed-tenant list cannot
 * reach them. Named so they are not mistaken for open defects, and so a real
 * one is not hidden behind the same excuse silently.
 *
 * EMPTIED 2026-09-08, and the excuse was retired rather than repriced.
 * `DataQualityResolutionService.claim` and `.reopen` were the only two entries;
 * both were extracted into free functions in `data-quality-finding-claim.ts`, and
 * the caller-side reasoning that excused them became an explicit guard:
 * `DataQualityResolutionService.resolve` now calls `assertFindingsInOrg`, which
 * selects the requested ids under `organizationId`, compares the row count and
 * throws `NotFoundException` for the WHOLE request — 404, never 403 — before the
 * status filter is applied, so a foreign id is no longer indistinguishable from
 * a skip. Neither name appears in the scan's inventory any more. An entry may
 * only return here with the same kind of evidence.
 */
const GUARDED_BY_CALLER: readonly string[] = [];

const source = (rel: string): string => readFileSync(join(BACKEND_ROOT, rel), "utf8");

describe("BOLA sweep — bulk endpoints refuse a mixed-tenant id list", () => {
  const sites = findBulkSites();
  const failWhole = sites.filter((s) => s.verdict === "fail-whole");
  const noCountCheck = sites.filter((s) => s.verdict === "no-count-check");
  const name = (s: { owner: string; method: string }): string => `${s.owner}.${s.method}`;

  it("ANTI-VACUITY: the scan finds real bulk sites on both sides of the verdict", () => {
    expect(sites.length).toBeGreaterThan(20);
    expect(failWhole.length).toBeGreaterThan(0);
    expect(noCountCheck.length).toBeGreaterThan(0);
  });

  it("SELF-TEST: parameter names are read from the signature, destructuring included", () => {
    const names = parameterNames("  async bulkUpdate(orgId: string, { dealIds }: Input) ");
    expect(names.has("orgId")).toBe(true);
    expect(names.has("dealIds")).toBe(true);
  });

  it("SELF-TEST: an id list rebound to a local is still caller-supplied", () => {
    const method = {
      signature: "  async f(orgId: string, input: { ids: string[] }) ",
      body: "const requestedIds = [...new Set(input.ids)]; await q(inArray(t.id, requestedIds));",
    };
    expect(derivedIdLocals(method).has("requestedIds")).toBe(true);
    expect(classifyBulkMethod(method)).toBe("no-count-check");
  });

  it("SELF-TEST: a guard extracted into a private helper still counts", () => {
    const siblings = new Map([
      [
        "assertOwnsAll",
        {
          owner: "X",
          file: "x.ts",
          name: "assertOwnsAll",
          signature: "  private async assertOwnsAll(orgId: string, ids: string[]) ",
          body: "if (owned.length !== requestedIds.length) throw new NotFoundException();",
        },
      ],
    ]);
    const caller = {
      owner: "X",
      file: "x.ts",
      name: "f",
      signature: "  async f(orgId: string, input: { ids: string[] }) ",
      body: "const requestedIds = await this.assertOwnsAll(orgId, input.ids); await q(inArray(t.id, requestedIds));",
    };
    expect(classifyBulkMethod(caller)).toBe("no-count-check");
    expect(classifyBulkMethod(caller, siblings)).toBe("fail-whole");
  });

  /**
   * The hole this closes: before 2026-09-10 a bulk query moved into an exported
   * module function vanished from the scan altogether, because the calling method
   * no longer contained an `inArray` and answered "not-bulk". A guarded site went
   * quiet and so would an unguarded one.
   */
  it("SELF-TEST: a bulk query delegated to a module-level function is still seen", () => {
    const helpers = new Map([
      [
        "readMutationRows",
        {
          owner: "module",
          file: "policy.ts",
          name: "readMutationRows",
          signature: "export async function readMutationRows(tx: Tx, orgId: string, ids: number[]) ",
          body: "const rows = await tx.select().from(t).where(inArray(t.id, ids)); if (rows.length !== ids.length) throw new NotFoundException();",
        },
      ],
      [
        "readMutationRowsUnguarded",
        {
          owner: "module",
          file: "policy.ts",
          name: "readMutationRowsUnguarded",
          signature: "export async function readMutationRowsUnguarded(tx: Tx, orgId: string, ids: number[]) ",
          body: "return tx.select().from(t).where(inArray(t.id, ids));",
        },
      ],
    ]);
    const guarded = {
      owner: "X",
      file: "x.ts",
      name: "bulkUpdate",
      signature: "  async bulkUpdate(orgId: string, ticketIds: number[]) ",
      body: "return readMutationRows(tx, orgId, ticketIds);",
    };
    const unguarded = { ...guarded, body: "return readMutationRowsUnguarded(tx, orgId, ticketIds);" };

    // Without the helper index the site is invisible — that was the defect.
    expect(classifyBulkMethod(guarded)).toBe("not-bulk");
    expect(classifyBulkMethod(guarded, undefined, helpers)).toBe("fail-whole");
    expect(classifyBulkMethod(unguarded, undefined, helpers)).toBe("no-count-check");
  });

  it("SELF-TEST: a set-difference refusal counts as a guard", () => {
    const method = {
      signature: "  async f(orgId: string, input: { templateIds: number[] }) ",
      body:
        "const found = await q(inArray(t.id, input.templateIds));\n" +
        "const missing = input.templateIds.filter((id) => !found.find((f) => f.id === id));\n" +
        "if (missing.length > 0) throw new NotFoundException(`missing`);",
    };
    expect(classifyBulkMethod(method)).toBe("fail-whole");
  });

  it("SELF-TEST: a count check is what separates the two verdicts", () => {
    const withGuard = {
      owner: "X",
      file: "x.ts",
      name: "f",
      signature: "  async f(orgId: string, input: { ids: string[] }) ",
      body: "const found = await q(inArray(t.id, input.ids)); if (found.length !== input.ids.length) throw new NotFoundException();",
    };
    const withoutGuard = { ...withGuard, body: "await q(inArray(t.id, input.ids)); return { ok: true };" };
    expect(classifyBulkMethod(withGuard)).toBe("fail-whole");
    expect(classifyBulkMethod(withoutGuard)).toBe("no-count-check");
  });

  it("SELF-TEST: ids derived inside the method are not treated as caller-supplied", () => {
    const derived = {
      owner: "X",
      file: "x.ts",
      name: "f",
      signature: "  async f(orgId: string) ",
      body: "const ownedIds = await mine(orgId); await q(inArray(t.id, ownedIds));",
    };
    expect(classifyBulkMethod(derived)).toBe("not-bulk");
  });

  it("REFERENCE: the correct shape exists and is the one to copy", () => {
    // The check moved out of ProjectsTicketsQueryService when that file was split;
    // readMutationTickets is now the single owner every bulk ticket mutation calls.
    const reference = source("src/modules/build/core/build-ticket-mutation-policy.ts");
    expect(reference).toContain("rows.length !== ids.length");
    expect(reference).toContain("One or more ticket IDs not found in this project");
    expect(source("src/modules/build/core/projects-tickets-query.service.ts")).toContain(
      "readMutationTickets(tx, actor, projectId, ticketIds, policy)",
    );
    // Deliberately asserted against the code path, not against the classifier's
    // verdict: readMutationTickets is a module-level function, and the classifier
    // only follows helpers inside the same class, so bulkUpdate no longer appears
    // in failWhole even though it is guarded. See the RATCHET test below.
    expect(reference).toContain("rows.some((row) => !row.allowed)");
  });

  it("RATCHET: no new bulk site appears without a count check", () => {
    expect(sites.length).toBeGreaterThanOrEqual(BULK_SITE_FLOOR);
    expect(noCountCheck.length).toBeLessThanOrEqual(NO_COUNT_CHECK_BASELINE);
    expect(failWhole.length).toBeGreaterThanOrEqual(FAIL_WHOLE_FLOOR);
  });

  it("FIXED: every repaired site now refuses a partial match", () => {
    const guarded = new Set(failWhole.map(name));
    expect(REPAIRED_FAIL_WHOLE.filter((s) => !guarded.has(s))).toEqual([]);
  });

  it("EXCLUDED-BY-SCOPE: the CRM sites are still open and still detected as such", () => {
    const detected = new Set(noCountCheck.map(name));
    const undetected = CONFIRMED_SILENT_SUBSET.filter(
      (s) => !detected.has(s) && sites.some((site) => name(site) === s),
    );
    expect(undetected).toEqual([]);
  });

  it("TRIAGED: the remaining unguarded sites are named, not merely counted", () => {
    const unexplained = noCountCheck
      .map(name)
      .filter((s) => CONFIRMED_SILENT_SUBSET.includes(s) || GUARDED_BY_CALLER.includes(s));
    expect(unexplained.sort()).toEqual(
      [...CONFIRMED_SILENT_SUBSET, ...GUARDED_BY_CALLER].sort(),
    );
  });
});

describe("BOLA sweep — an id list with no tenant column at all", () => {
  const index = buildSourceIndex();

  /**
   * `email_sequence_enrollments` carries no `org_id`, and `enrollSequence`
   * verified the sequence but never the candidates, so another organization's
   * candidate ids attached to the caller's sequence and were reported as
   * enrolled. `candidate_id` is a foreign key, so an unknown id errored while a
   * real cross-tenant id succeeded — a clean existence oracle over the candidate
   * table.
   *
   * The assertion is inverted rather than deleted. It used to pin the defect, so
   * it could not go green and stay honest; as a regression guard it fails if the
   * ownership check is ever removed. The durable fix is still an `org_id` column
   * on the enrolment table; this is the service-level guard that closes the
   * oracle without one.
   */
  it("FIXED hr/recruitment: enrollSequence verifies every candidate before inserting", () => {
    const method = index.methodsByClass
      .get("RecruitmentAutomationService")
      ?.get("enrollSequence");
    expect(method).toBeDefined();
    expect(method?.body).toContain("eq(emailSequences.orgId, orgId)");
    expect(method?.body).toContain("eq(candidates.orgId, orgId)");
    expect(method?.body).toContain("owned.length !== requestedIds.length");
    expect(method?.body).toContain("NotFoundException");
    expect(method?.body).not.toContain("ForbiddenException");
    expect(classifyBulkMethod(method as never)).toBe("fail-whole");
  });

  /**
   * The durable half of the same defect, which the service guard above could only work around.
   *
   * `email_sequence_enrollments` now carries `org_id`, and — the part that matters — its two
   * foreign keys are COMPOSITE and tenant-anchored: `(org_id, sequence_id)` into
   * `email_sequences(org_id, id)` and `(org_id, candidate_id)` into `candidates(org_id, id)`.
   * A single-column `candidate_id` reference would accept another organization's candidate and
   * leave the whole guarantee resting on the service remembering to check. Anchored this way the
   * database refuses the row, so the oracle cannot be reopened by an unrelated code path.
   */
  it("FIXED hr/recruitment: the enrollment table anchors both its references to the tenant", () => {
    const schema = source("src/db/schema/hr/hiring-pipeline.ts");
    const start = schema.indexOf('emailSequenceEnrollments = pgTable("email_sequence_enrollments"');
    expect(start).toBeGreaterThan(-1);
    const table = schema.slice(start);
    const body = table.slice(0, table.indexOf("]);"));
    expect(body).toContain('orgId: text("org_id")');
    expect(body).toContain(".notNull()");
    expect(body).toContain("columns: [table.orgId, table.sequenceId]");
    expect(body).toContain("foreignColumns: [emailSequences.orgId, emailSequences.id]");
    expect(body).toContain("columns: [table.orgId, table.candidateId]");
    expect(body).toContain("foreignColumns: [candidates.orgId, candidates.id]");
  });
});
