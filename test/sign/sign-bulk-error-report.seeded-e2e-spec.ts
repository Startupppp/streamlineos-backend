import request from "supertest";
import { eq } from "drizzle-orm";
import {
  orgModules,
  signBulkSendJobs,
  signBulkSendRows,
  signTemplates,
} from "src/db/schema";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * SIGN-P2-04. Verify the bulk error report after the async rewrite.
 *
 * It did not survive it — and it had not really worked before. `getErrorReport`
 * was `getJob(...).rows.filter(failed)`, and `getJob` caps its rows at 100
 * ordered by row number. So a job whose first hundred rows succeeded
 * returned an EMPTY error report while the job itself reported hundreds of
 * failures. The one screen somebody opens to find out what went wrong showed
 * nothing, and nothing is indistinguishable from "no problems".
 *
 * That mattered less when bulk send ran inside the request and jobs stayed
 * small by necessity. Moving the work to a worker was precisely so they could
 * be large: `bulkSendMaxRowsPerJob` defaults to 500 and an organisation may
 * set it to 10,000.
 *
 * The fixture is shaped to make the old code answer wrongly: 120 rows, the
 * first 100 sent, the last 20 failed. Under the old implementation the page
 * stops at row 100 and the filter finds nothing.
 *
 * Rows are seeded directly rather than produced by a real run, because
 * producing a *successful* row needs a document in storage — and what is under
 * test is the report, not the send.
 *
 * Run with:
 *   DATABASE_URL=postgres://owner@host/db \
 *   APP_DATABASE_URL=postgres://streamline_app@host/db \
 *   node --max-old-space-size=12288 ./node_modules/jest/bin/jest.js \
 *     --config ./jest-e2e-seeded.json --forceExit --runInBand \
 *     --testPathPattern=sign-bulk-error-report
 */

const SENT_ROWS = 100;
const FAILED_ROWS = 20;

describe(`${SEEDED_HARNESS} the bulk error report reports every error`, () => {
  let seeded: SeededE2eApp;
  let fixture: SeededFixture;
  let otherFixture: SeededFixture;
  let token = "";
  let otherToken = "";
  let jobId = 0;

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    fixture = await seedOrg(seeded.seedDb)
      .addMember("sender", { permissionKeys: ["sign:bulk_send:run"] })
      .build();
    otherFixture = await seedOrg(seeded.seedDb)
      .addMember("stranger", { permissionKeys: ["sign:bulk_send:run"] })
      .build();

    for (const org of [fixture.orgId, otherFixture.orgId]) {
      await seeded.seedDb
        .insert(orgModules)
        .values({ orgId: org, moduleKey: "sign", enabled: true })
        .onConflictDoNothing();
    }

    token = await signSeededToken(seeded, fixture.members["sender"]!.userId, fixture.orgId);
    otherToken = await signSeededToken(seeded, 
      otherFixture.members["stranger"]!.userId,
      otherFixture.orgId,
    );

    const [template] = await seeded.seedDb
      .insert(signTemplates)
      .values({
        orgId: fixture.orgId,
        name: "Error report probe",
        status: "published",
        ownerMembershipId: fixture.members["sender"]!.membershipId,
        templateJson: { roles: [], documents: [], fields: [] },
      })
      .returning({ id: signTemplates.id });

    const [job] = await seeded.seedDb
      .insert(signBulkSendJobs)
      .values({
        orgId: fixture.orgId,
        templateId: template!.id,
        senderMembershipId: fixture.members["sender"]!.membershipId,
        status: "completed",
        totalCount: SENT_ROWS + FAILED_ROWS,
        successCount: SENT_ROWS,
        failedCount: FAILED_ROWS,
        columnMappingJson: { name: "name", email: "email" },
        completedAt: new Date(),
      })
      .returning({ id: signBulkSendJobs.id });
    jobId = job!.id;

    /** One shape for both branches: a union of two row shapes is not an insert. */
    const rows: (typeof signBulkSendRows.$inferInsert)[] = [
      ...Array.from({ length: SENT_ROWS }, (_, i) => ({
        orgId: fixture.orgId,
        jobId,
        rowNumber: i + 1,
        rawDataJson: { name: `Fine ${i + 1}`, email: `fine${i + 1}@test.invalid` },
        status: "success" as const,
        errorMessage: null,
      })),
      ...Array.from({ length: FAILED_ROWS }, (_, i) => ({
        orgId: fixture.orgId,
        jobId,
        rowNumber: SENT_ROWS + i + 1,
        rawDataJson: { name: `Broken ${i + 1}`, email: "not-an-email" },
        status: "failed" as const,
        errorMessage: `row ${SENT_ROWS + i + 1}: invalid email`,
      })),
    ];
    await seeded.seedDb.insert(signBulkSendRows).values(rows);
  }, 240_000);

  afterAll(async () => {
    if (fixture) {
      await seeded.seedDb.delete(signBulkSendJobs).where(eq(signBulkSendJobs.orgId, fixture.orgId));
      await seeded.seedDb.delete(signTemplates).where(eq(signTemplates.orgId, fixture.orgId));
      await fixture.teardown();
    }
    if (otherFixture) await otherFixture.teardown();
    await seeded?.close();
  }, 60_000);

  const errorReport = (bearer: string) =>
    request(seeded.app.getHttpServer())
      .get(`/sign/bulk-send/jobs/${jobId}/error-report`)
      .set("Authorization", `Bearer ${bearer}`);

  it("returns every failed row, not the failures in the first page", async () => {
    const res = await errorReport(token);

    expect(res.status).toBe(200);
    /**
     * The assertion the old implementation failed: the failures live beyond
     * row 100, so a report built from the first page found none of them.
     */
    expect(res.body.rows).toHaveLength(FAILED_ROWS);
    expect(res.body.rows.every((r: { status: string }) => r.status === "failed")).toBe(true);
  }, 60_000);

  it("says why each row failed, and which row it was", async () => {
    const res = await errorReport(token);

    const first = res.body.rows[0];
    expect(first.rowNumber).toBe(SENT_ROWS + 1);
    expect(first.errorMessage).toMatch(/invalid email/i);
    /** The original spreadsheet row, so the operator can find and fix it. */
    expect(first.rawDataJson).toMatchObject({ email: "not-an-email" });
  }, 60_000);

  it("reports the job's own failure count, so a short report cannot look complete", async () => {
    const res = await errorReport(token);

    expect(res.body.failedCount).toBe(FAILED_ROWS);
    expect(res.body.returned).toBe(FAILED_ROWS);
    expect(res.body.truncated).toBe(false);
  }, 60_000);

  it("is 404 for another organisation's job, not 403", async () => {
    /** A 403 would confirm the job exists. */
    const res = await errorReport(otherToken);
    expect(res.status).toBe(404);
  }, 60_000);

  it("tells the detail view that its row list is a page", async () => {
    const res = await request(seeded.app.getHttpServer())
      .get(`/sign/bulk-send/jobs/${jobId}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(100);
    /**
     * Without this the caller cannot distinguish a complete list from the
     * first hundred of one — the same silence that hid the error-report bug.
     */
    expect(res.body.rowsTruncated).toBe(true);
    expect(res.body.job.totalCount).toBe(SENT_ROWS + FAILED_ROWS);
  }, 60_000);
});
