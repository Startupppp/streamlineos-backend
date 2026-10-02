import type { Table } from "drizzle-orm";
import { hrExportJobs, kbPages, surveyForms } from "src/db/schema";
import type { ExpectedOutcome, Observation, Scenario } from "../matrix.types";
import { createCollector, exportJob, reindexPage } from "../adapters/records-adapter";
import { ORG_A, ORG_B, userOf, type Standing } from "../standings";
import type { Row, WorldDb } from "../world-db";

export const KB_PAGE_A = 4242;
export const ABSENT_KB_PAGE = 999_999;
export const SURVEY_A = 4343;
export const EXPORT_JOB_A = "0e000000-0000-4000-8000-0000000000e1";

export function kbSurveyExportRows(): Map<Table, Row[]> {
  return new Map<Table, Row[]>([
    [kbPages, [{ id: KB_PAGE_A, orgId: ORG_A, deletedAt: null }]],
    [surveyForms, [{ id: SURVEY_A, orgId: ORG_A }]],
    [
      hrExportJobs,
      [
        {
          id: EXPORT_JOB_A,
          orgId: ORG_A,
          entity: "employees",
          status: "completed",
          filters: {},
          requestedScope: "all",
          requestedBy: userOf("org:admin", ORG_A),
          fileKey: `${ORG_A}/exports/${EXPORT_JOB_A}.csv`,
          fileName: "employee-directory.csv",
          processedRows: 1,
          rowCount: 1,
          errorCode: null,
          errorMessage: null,
          createdAt: new Date("2026-09-01T00:00:00Z"),
          updatedAt: new Date("2026-09-01T00:00:00Z"),
          completedAt: new Date("2026-09-01T00:00:00Z"),
          expiresAt: new Date("2999-01-01T00:00:00Z"),
        },
      ],
    ],
  ]);
}

interface Case {
  readonly suffix: string;
  readonly standing: Standing;
  readonly orgId: string;
  readonly expected: ExpectedOutcome;
  readonly because: string;
}

function scenarioSet(
  prefix: string,
  base: Pick<Scenario, "resource" | "action" | "covers">,
  adapter: "http" | "file",
  entry: string,
  cases: readonly Case[],
  run: (item: Case) => Promise<Observation>,
): Scenario[] {
  const allowed = cases.find((item) => item.expected === "allow");
  return cases.map((item) => ({
    ...base,
    id: `${prefix}-${item.suffix}`,
    actor: item.standing,
    tenant: item.orgId === ORG_A ? "same" : "other",
    state: "normal",
    expected: item.expected,
    because: item.because,
    pairedWith: item.expected === "allow" || allowed === undefined ? undefined : `${prefix}-${allowed.suffix}`,
    bindings: [{ adapter, entry, run: () => run(item) }],
  }));
}

function reindexScenarios(world: WorldDb): Scenario[] {
  const cases: Case[] = [
    { suffix: "org-admin", standing: "org:admin", orgId: ORG_A, expected: "allow", because: "the request path finds the caller's own page and only then reindexes it" },
    { suffix: "cross-tenant", standing: "org:admin", orgId: ORG_B, expected: "404", because: "another organisation's page id is not found, never Forbidden and never a 200 that claims it was reindexed" },
    { suffix: "org-member", standing: "org:member", orgId: ORG_A, expected: "403", because: "a plain member does not hold kb:pages:manage, so the guard refuses before any lookup" },
  ];
  const absent: Scenario = {
    id: "kb-page-reindex-absent",
    actor: "org:admin",
    resource: "kb:page",
    action: "reindex",
    tenant: "same",
    state: "normal",
    expected: "404",
    because: "an id belonging to no organisation answers exactly as a foreign one, so the route is no existence oracle",
    pairedWith: "kb-page-reindex-org-admin",
    covers: [],
    bindings: [{ adapter: "http", entry: "POST /kb/pages/:pageId/reindex -> KbIndexingService.reindexPageOnRequest", run: () => reindexPage(world, "org:admin", ORG_A, ABSENT_KB_PAGE) }],
  };
  return [
    ...scenarioSet(
      "kb-page-reindex",
      { resource: "kb:page", action: "reindex", covers: [] },
      "http",
      "POST /kb/pages/:pageId/reindex -> KbIndexingService.reindexPageOnRequest",
      cases,
      (item) => reindexPage(world, item.standing, item.orgId, KB_PAGE_A),
    ),
    absent,
  ];
}

function collectorScenarios(world: WorldDb): Scenario[] {
  const cases: Case[] = [
    { suffix: "org-admin", standing: "org:admin", orgId: ORG_A, expected: "allow", because: "the caller's own survey gets a collector bound to the caller's org" },
    { suffix: "cross-tenant", standing: "org:admin", orgId: ORG_B, expected: "404", because: "the survey is resolved under the caller's org first, so a foreign survey id is a 404, never a 500 from the tenant FK, and nothing is inserted" },
    { suffix: "org-member", standing: "org:member", orgId: ORG_A, expected: "403", because: "a plain member does not hold surveys:participants:manage" },
  ];
  return scenarioSet(
    "survey-collector-create",
    { resource: "surveys:collector", action: "create", covers: [] },
    "http",
    "POST /surveys/:surveyId/collectors -> SurveyCollectorService.create",
    cases,
    (item) => createCollector(world, item.standing, item.orgId, SURVEY_A),
  );
}

function exportScenarios(world: WorldDb): Scenario[] {
  const readCases: Case[] = [
    { suffix: "requester", standing: "org:admin", orgId: ORG_A, expected: "allow", because: "the requester reads its own export job" },
    { suffix: "cross-tenant", standing: "org:admin", orgId: ORG_B, expected: "404", because: "another organisation's export job id is not found, not forbidden" },
    { suffix: "other-requester", standing: "org:owner", orgId: ORG_A, expected: "404", because: "the lookup binds the requester too, so a colleague's job is not found" },
  ];
  const downloadCases: Case[] = [
    { suffix: "requester", standing: "org:admin", orgId: ORG_A, expected: "allow", because: "the requester downloads its own completed export and the stream opens under its own org" },
    { suffix: "cross-tenant", standing: "org:admin", orgId: ORG_B, expected: "404", because: "the job lookup refuses another organisation's id before the object store is opened" },
    { suffix: "other-requester", standing: "org:owner", orgId: ORG_A, expected: "404", because: "a colleague's export is not found and its file is never streamed" },
  ];
  return [
    ...scenarioSet(
      "hr-export-job-read",
      { resource: "hr:export-job", action: "read", covers: [] },
      "http",
      "GET /hr/export/jobs/:exportJobId -> HrExportJobsService.getForRequester",
      readCases,
      (item) => exportJob(world, "read", item.standing, item.orgId, EXPORT_JOB_A, ORG_A),
    ),
    ...scenarioSet(
      "hr-export-job-download",
      { resource: "hr:export-job", action: "download", covers: [] },
      "file",
      "GET /hr/export/jobs/:exportJobId/download -> HrExportJobsService.getDownload -> storage stream",
      downloadCases,
      (item) => exportJob(world, "download", item.standing, item.orgId, EXPORT_JOB_A, ORG_A),
    ),
  ];
}

export function kbSurveyExportScenarios(world: WorldDb): Scenario[] {
  return [...reindexScenarios(world), ...collectorScenarios(world), ...exportScenarios(world)];
}
