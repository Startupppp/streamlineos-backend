import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findBulkSites, classifyBulkMethod, parameterNames } from "./bulk-id-handling";
import { BACKEND_ROOT } from "./route-surface";
import { buildSourceIndex } from "./tenant-binding";

/**
 * A bulk endpoint handed a mixed-tenant id list must fail the whole request.
 * `inArray(table.id, ids)` beside `eq(table.orgId, orgId)` is not isolation: it
 * silently narrows the work to the rows the caller owns and returns success, so
 * the caller believes every id was acted on and the response distinguishes
 * "not yours" from "already done".
 */

const BULK_SITE_BASELINE = 55;
const NO_COUNT_CHECK_BASELINE = 51;
const FAIL_WHOLE_FLOOR = 4;

/**
 * Sites read in full and confirmed to process the owned subset silently. Kept
 * explicit so a fix is visible as this list shrinking, rather than as a number
 * moving. Ranked by blast radius.
 */
const CONFIRMED_SILENT_SUBSET: readonly string[] = [
  "NotificationsLifecycleService.bulkDelete",
  "NotificationsLifecycleService.bulkArchive",
  "NotificationsLifecycleService.bulkMarkRead",
  "DealsCrudService.bulkDelete",
  "DealsCrudService.bulkUpdate",
  "RecruitmentCandidateOpsService.bulkReject",
  "RecruitmentCandidateOpsService.bulkShortlist",
  "SurveyParticipantService.invite",
  "SurveyParticipantService.remind",
  "KbTagsService.setArticleTags",
  "ApprovalsBulkService.bulkReject",
  "DataQualityResolutionService.claim",
];

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
    const reference = source("src/modules/build/core/projects-tickets-query.service.ts");
    expect(reference).toContain("found.length !== body.ticketIds.length");
    expect(reference).toContain("One or more ticket IDs not found in this project");
    expect(failWhole.map(name)).toContain("ProjectsTicketsQueryService.bulkUpdate");
  });

  it("RATCHET: no new bulk site appears without a count check", () => {
    expect(sites.length).toBeLessThanOrEqual(BULK_SITE_BASELINE);
    expect(noCountCheck.length).toBeLessThanOrEqual(NO_COUNT_CHECK_BASELINE);
    expect(failWhole.length).toBeGreaterThanOrEqual(FAIL_WHOLE_FLOOR);
  });

  it("PINNED: every confirmed silent-subset site is still detected as such", () => {
    const detected = new Set(noCountCheck.map(name));
    const undetected = CONFIRMED_SILENT_SUBSET.filter(
      (s) => !detected.has(s) && sites.some((site) => name(site) === s),
    );
    expect(undetected).toEqual([]);
  });
});

describe("BOLA sweep — an id list with no tenant column at all", () => {
  const index = buildSourceIndex();

  /**
   * `email_sequence_enrollments` carries no `org_id`, and `enrollSequence`
   * verifies the sequence but never the candidates, so another organization's
   * candidate ids attach to the caller's sequence and are reported as enrolled.
   * `candidate_id` is a foreign key, so an unknown id errors while a real
   * cross-tenant id succeeds — a clean existence oracle over the candidate table.
   */
  it("KNOWN-OPEN hr/recruitment: enrollSequence does not verify candidate ownership", () => {
    const method = index.methodsByClass
      .get("RecruitmentAutomationService")
      ?.get("enrollSequence");
    expect(method).toBeDefined();
    expect(method?.body).toContain("eq(emailSequences.orgId, orgId)");

    const verifiesCandidates =
      method?.body.includes("candidates.orgId") === true ||
      method?.body.includes("candidateIds.length") === true;
    expect(verifiesCandidates).toBe(false);
  });

  it("KNOWN-OPEN: the enrollment table has no tenant column to bind", () => {
    const schema = source("src/db/schema/hr/hiring-pipeline.ts");
    const table = schema.slice(
      schema.indexOf('emailSequenceEnrollments = pgTable("email_sequence_enrollments"'),
    );
    expect(table.slice(0, table.indexOf("]);"))).not.toContain("orgId");
  });
});
