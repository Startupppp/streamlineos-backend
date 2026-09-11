import { randomUUID } from "node:crypto";
import request from "supertest";
import { eq } from "drizzle-orm";
import { crmReportDefinitions, crmReportRuns, orgModules, users } from "src/db/schema";
import { businessParties } from "src/db/schema/party";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * CRM-P1-03. The saved half of `crm/reporting`, over real HTTP and real RLS.
 *
 * The controller has always exposed eight routes. Six of them — save, list,
 * open, update, delete, run-a-saved-one — plus `explain` and the run log had no
 * caller anywhere in the product and no test anywhere in this repo, so nothing
 * had ever established that they work at all: not the permission split, not the
 * tenant policies on `crm_report_definitions` and `crm_report_runs`, not the
 * shapes the frontend now consumes. A builder that could compose a query and
 * lose it on navigation was the visible half of that.
 *
 * The test that matters is the third one. Running a saved report by its id and
 * running the identical description ad hoc execute the same statement, and the
 * only difference between them is the audit row: one names the definition and
 * one does not. That difference is the entire reason the frontend decides
 * between the two routes rather than always taking the simpler one, so it is
 * asserted rather than assumed.
 *
 * Run with:
 *   DATABASE_URL=postgres://owner@host/db \
 *   APP_DATABASE_URL=postgres://streamline_app@host/db \
 *   node --max-old-space-size=12288 ./node_modules/jest/bin/jest.js \
 *     --config ./jest-e2e-seeded.json --forceExit --runInBand \
 *     --testPathPattern=crm-reporting-saved-reports
 */

const ANALYST_KEYS = [
  "crm:reporting:view",
  "crm:reporting:manage",
  "crm:reporting:run",
  "party:parties:view",
] as const;

/** Everything reporting needs, and nothing that lets the rows be read. */
const NO_SOURCE_KEYS = [
  "crm:reporting:view",
  "crm:reporting:manage",
  "crm:reporting:run",
] as const;

const ANALYST_NAME = "Rukmini Analyst";

describe(`${SEEDED_HARNESS} saved reports survive the page they were built on`, () => {
  let seeded: SeededE2eApp;
  let fixture: SeededFixture;
  let analystToken = "";
  let strangerToken = "";
  let reportDefinitionId = "";

  const query = {
    source: "parties",
    select: [
      { kind: "field" as const, field: "industry" },
      { kind: "aggregate" as const, aggregate: "count" as const },
    ],
    filter: {
      kind: "compare" as const,
      field: "name",
      operator: "starts_with" as const,
      value: "Reporting probe",
    },
    groupBy: ["industry"],
    limit: 100,
  };

  const asAnalyst = () => request(seeded.app.getHttpServer());

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    fixture = await seedOrg(seeded.seedDb)
      .addMember("analyst", { permissionKeys: [...ANALYST_KEYS] })
      .addMember("stranger", { permissionKeys: [...NO_SOURCE_KEYS] })
      .build();

    const analyst = fixture.members["analyst"]!;
    /**
     * The seed builder stores identity only — id and email — so the name the
     * list and the run log project has to be put there deliberately. Without it
     * this spec would pass with the join returning null and would prove nothing
     * about it.
     */
    await seeded.seedDb
      .update(users)
      .set({ name: ANALYST_NAME })
      .where(eq(users.id, analyst.userId));

    /** Every reporting route carries `@RequireModule("crm")`; without this it is 402. */
    await seeded.seedDb
      .insert(orgModules)
      .values({ orgId: fixture.orgId, moduleKey: "crm", enabled: true })
      .onConflictDoNothing();

    analystToken = await signSeededToken(seeded, analyst.userId, fixture.orgId);
    strangerToken = await signSeededToken(seeded, 
      fixture.members["stranger"]!.userId,
      fixture.orgId,
    );

    for (const industry of ["Textiles", "Textiles", "Logistics"])
      await seeded.seedDb.insert(businessParties).values({
        partyId: randomUUID(),
        organizationId: fixture.orgId,
        name: `Reporting probe ${randomUUID().slice(0, 8)}`,
        industry,
      });
  }, 240_000);

  afterAll(async () => {
    if (fixture) {
      await seeded.seedDb
        .delete(crmReportRuns)
        .where(eq(crmReportRuns.organizationId, fixture.orgId));
      await seeded.seedDb
        .delete(crmReportDefinitions)
        .where(eq(crmReportDefinitions.organizationId, fixture.orgId));
      await seeded.seedDb
        .delete(businessParties)
        .where(eq(businessParties.organizationId, fixture.orgId));
      await fixture.teardown();
    }
    await seeded?.close();
  }, 60_000);

  it("saves a report and hands back the row the builder reopens", async () => {
    const response = await asAnalyst()
      .post("/crm/reporting/definitions")
      .set("Authorization", `Bearer ${analystToken}`)
      .send({
        name: `Parties by industry ${randomUUID().slice(0, 8)}`,
        description: "How many customers sit in each industry.",
        query,
      })
      .expect(201);

    const body = response.body.data ?? response.body;
    expect(typeof body.reportDefinitionId).toBe("string");
    expect(body.sourceKey).toBe("parties");
    /** The description round-trips, because it is what a reopen puts in the form. */
    expect(body.queryDescription).toEqual(query);
    reportDefinitionId = body.reportDefinitionId;
  }, 120_000);

  it("lists it with the author as a name rather than an id", async () => {
    const response = await asAnalyst()
      .get("/crm/reporting/definitions?limit=25&offset=0")
      .set("Authorization", `Bearer ${analystToken}`)
      .expect(200);

    const rows = response.body.data ?? response.body;
    const saved = rows.find(
      (row: { reportDefinitionId: string }) =>
        row.reportDefinitionId === reportDefinitionId,
    );

    expect(saved).toBeDefined();
    expect(saved.createdByName).toBe(ANALYST_NAME);
    /** The list projects no description body; that is the detail read's job. */
    expect(saved.queryDescription).toBeUndefined();
  }, 120_000);

  it("runs the saved report by id, and files the run against it", async () => {
    const run = await asAnalyst()
      .post(`/crm/reporting/definitions/${reportDefinitionId}/run`)
      .set("Authorization", `Bearer ${analystToken}`)
      .send({ limit: 50 })
      .expect(201);

    const result = run.body.data ?? run.body;
    expect(result.rowCount).toBe(2);
    expect(result.truncated).toBe(false);

    const log = await asAnalyst()
      .get("/crm/reporting/runs?limit=5&offset=0")
      .set("Authorization", `Bearer ${analystToken}`)
      .expect(200);

    const [latest] = log.body.data ?? log.body;
    expect(latest.reportDefinitionId).toBe(reportDefinitionId);
    expect(latest.ranByName).toBe(ANALYST_NAME);
    expect(latest.rowCount).toBe(2);
    /** The audit read is grantable without a view of the data because of this. */
    expect(latest.compiledSql).not.toContain("Reporting probe");
    expect(latest.parameterCount).toBeGreaterThan(0);
  }, 120_000);

  it("files the identical question asked ad hoc as an ad-hoc run", async () => {
    /**
     * The distinction the frontend's run-mode decision exists to preserve. Same
     * description, same statement, same rows — and an audit row that does not
     * claim the saved report was run, because it was not.
     */
    await asAnalyst()
      .post("/crm/reporting/run")
      .set("Authorization", `Bearer ${analystToken}`)
      .send({ query })
      .expect(201);

    const log = await asAnalyst()
      .get("/crm/reporting/runs?limit=5&offset=0")
      .set("Authorization", `Bearer ${analystToken}`)
      .expect(200);

    const [latest] = log.body.data ?? log.body;
    expect(latest.reportDefinitionId).toBeNull();
    expect(latest.sourceKey).toBe("parties");
  }, 120_000);

  it("explains without executing, and without echoing the values", async () => {
    const response = await asAnalyst()
      .post("/crm/reporting/explain")
      .set("Authorization", `Bearer ${analystToken}`)
      .send({ query })
      .expect(201);

    const explained = response.body.data ?? response.body;
    expect(explained.source).toBe("parties");
    expect(explained.sql).toContain("business_parties");
    expect(explained.sql).not.toContain("Reporting probe");
    expect(explained.parameterCount).toBeGreaterThan(0);
    expect(Array.isArray(explained.columns)).toBe(true);

    const runs = await seeded.seedDb
      .select({ reportRunId: crmReportRuns.reportRunId })
      .from(crmReportRuns)
      .where(eq(crmReportRuns.organizationId, fixture.orgId));
    /** Two runs so far — the saved one and the ad-hoc one. Explain adds none. */
    expect(runs).toHaveLength(2);
  }, 120_000);

  it("edits the stored question in place", async () => {
    const response = await asAnalyst()
      .patch(`/crm/reporting/definitions/${reportDefinitionId}`)
      .set("Authorization", `Bearer ${analystToken}`)
      .send({ description: null, query: { ...query, limit: 10 } })
      .expect(200);

    const body = response.body.data ?? response.body;
    expect(body.description).toBeNull();
    expect(body.queryDescription.limit).toBe(10);
  }, 120_000);

  it("refuses the reporting keys alone as a way into the rows", async () => {
    /**
     * The module's whole safety argument: `crm:reporting:run` says a person may
     * run reports, not which data they may read. Without `party:parties:view`
     * reporting must not become the way to read what the parties screen refuses.
     */
    await asAnalyst()
      .post("/crm/reporting/run")
      .set("Authorization", `Bearer ${strangerToken}`)
      .send({ query })
      .expect(403);

    await asAnalyst()
      .post("/crm/reporting/definitions")
      .set("Authorization", `Bearer ${strangerToken}`)
      .send({ name: `Refused ${randomUUID().slice(0, 8)}`, query })
      .expect(403);
  }, 120_000);

  it("deletes it, and leaves the record of what it did behind", async () => {
    await asAnalyst()
      .delete(`/crm/reporting/definitions/${reportDefinitionId}`)
      .set("Authorization", `Bearer ${analystToken}`)
      .expect(200);

    await asAnalyst()
      .get(`/crm/reporting/definitions/${reportDefinitionId}`)
      .set("Authorization", `Bearer ${analystToken}`)
      .expect(404);

    /**
     * `crm_report_runs.report_definition_id` is deliberately not a foreign key,
     * so deleting a report cannot erase the evidence that it was run. The run
     * log keeps the id, and the activity screen renders it as a report that no
     * longer exists rather than as a blank.
     */
    const runs = await seeded.seedDb
      .select({ reportDefinitionId: crmReportRuns.reportDefinitionId })
      .from(crmReportRuns)
      .where(eq(crmReportRuns.organizationId, fixture.orgId));

    expect(runs.some((row) => row.reportDefinitionId === reportDefinitionId)).toBe(true);
  }, 120_000);
});
