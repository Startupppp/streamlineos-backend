import request from "supertest";
import { and, eq } from "drizzle-orm";
import {
  orgModules,
  outboxEvents,
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
import { SIGN_BULK_SEND_QUEUED } from "src/modules/e-sign/sign-bulk-send.service";

/**
 * SIGN-P0-05 and SIGN-P0-06. Bulk send used to happen inside the request.
 *
 * `createJob` called `process` inline: up to `bulk_send_max_rows_per_job`
 * envelopes — 500 by default — each a template instantiation and an email, all
 * before the HTTP response. The comment beside it called that "acceptable for
 * an admin-triggered, bounded-size job". Five hundred sends is not a request;
 * the first thing that happens at scale is a gateway timeout with an unknown
 * number of envelopes already delivered and no way to tell which.
 *
 * What this file proves is the shape of the fix: the request returns with the
 * job queued, an outbox event exists to carry the work, and the worker settles
 * it. The rows here deliberately fail mapping, so no document or storage
 * fixture is needed — and the honest limit of that is stated plainly: this
 * does not exercise a successful envelope send. The resumability and retry
 * budget have their own unit spec, where the row states can be driven directly.
 *
 * Run with:
 *   DATABASE_URL=postgres://owner@host/db \
 *   APP_DATABASE_URL=postgres://streamline_app@host/db CRON_SECRET=... \
 *   node --max-old-space-size=12288 ./node_modules/jest/bin/jest.js \
 *     --config ./jest-e2e-seeded.json --forceExit --runInBand \
 *     --testPathPattern=sign-bulk-send-async
 */

describe(`${SEEDED_HARNESS} bulk send is queued, not run in the request`, () => {
  let seeded: SeededE2eApp;
  let fixture: SeededFixture;
  let token = "";
  let templateId = 0;
  let jobId = 0;

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    fixture = await seedOrg(seeded.seedDb)
      .addMember("sender", { permissionKeys: ["sign:bulk_send:run", "sign:template:manage"] })
      .build();
    await seeded.seedDb
      .insert(orgModules)
      .values({ orgId: fixture.orgId, moduleKey: "sign", enabled: true })
      .onConflictDoNothing();

    token = await signSeededToken(fixture.members["sender"]!.userId, fixture.orgId);

    /**
     * Seeded directly: a published template with exactly one signer role is
     * all `createJob` checks, and building one through the API would mean
     * uploading a document to storage for a test about queueing.
     */
    const [template] = await seeded.seedDb
      .insert(signTemplates)
      .values({
        orgId: fixture.orgId,
        name: "Bulk probe template",
        status: "published",
        ownerMembershipId: fixture.members["sender"]!.membershipId,
        templateJson: {
          roles: [{ roleName: "Signer", recipientType: "signer", routingOrder: 1, authMethod: "email_link" }],
          documents: [],
          fields: [],
        },
      })
      .returning({ id: signTemplates.id });
    templateId = template!.id;
  }, 240_000);

  afterAll(async () => {
    if (fixture) {
      await seeded.seedDb.delete(signBulkSendJobs).where(eq(signBulkSendJobs.orgId, fixture.orgId));
      await seeded.seedDb.delete(signTemplates).where(eq(signTemplates.orgId, fixture.orgId));
      await fixture.teardown();
    }
    await seeded?.close();
  }, 60_000);

  const drainOutbox = async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const res = await request(seeded.app.getHttpServer())
        .post("/cron/outbox-events-worker")
        .set("Authorization", `Bearer ${process.env.CRON_SECRET ?? ""}`)
        .send({});
      expect(res.status).toBe(200);
      if (res.body?.skipped !== true) return true;
      await new Promise((r) => setTimeout(r, 3_000));
    }
    return false;
  };

  it("returns with the job queued rather than sent", async () => {
    const res = await request(seeded.app.getHttpServer())
      .post("/sign/bulk-send/jobs")
      .set("Authorization", `Bearer ${token}`)
      /** @Idempotent makes this header mandatory; without it the route 400s. */
      .set("Idempotency-Key", `bulk-async-${Date.now()}`)
      .send({
        templateId,
        columnMapping: { name: "name", email: "email" },
        /** Deliberately unmappable, so no envelope is attempted. */
        rows: [{ name: "", email: "" }, { name: "No Email", email: "not-an-email" }],
      });

    expect(res.status).toBe(201);
    expect(res.body.queued).toBe(true);
    jobId = res.body.job.id;
    expect(jobId).toBeGreaterThan(0);

    /** Not "completed": the request did not do the work. */
    expect(res.body.job.status).toBe("pending");
  }, 120_000);

  it("commits a queue entry in the same transaction as the job", async () => {
    const rows = await seeded.seedDb
      .select({ payload: outboxEvents.payload, aggregateId: outboxEvents.aggregateId })
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.organizationId, fixture.orgId),
          eq(outboxEvents.eventType, SIGN_BULK_SEND_QUEUED),
        ),
      );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.aggregateId).toBe(String(jobId));
    expect(rows[0]!.payload).toMatchObject({ job_id: jobId, total_count: 2 });
  }, 60_000);

  it("settles the job when the worker runs, and does not dead-letter", async () => {
    expect(await drainOutbox()).toBe(true);

    const [job] = await seeded.seedDb
      .select({ status: signBulkSendJobs.status, failedCount: signBulkSendJobs.failedCount, successCount: signBulkSendJobs.successCount })
      .from(signBulkSendJobs)
      .where(eq(signBulkSendJobs.id, jobId));

    expect(job).toMatchObject({ status: "completed", failedCount: 2, successCount: 0 });

    const [event] = await seeded.seedDb
      .select({ state: outboxEvents.deliveryState, lastError: outboxEvents.lastError })
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.organizationId, fixture.orgId),
          eq(outboxEvents.eventType, SIGN_BULK_SEND_QUEUED),
        ),
      );
    if (event?.state !== "DELIVERED") {
      throw new Error(`queue event is ${event?.state}: ${event?.lastError}`);
    }
  }, 180_000);

  it("records why each row failed, per row", async () => {
    const rows = await seeded.seedDb
      .select({ status: signBulkSendRows.status, errorMessage: signBulkSendRows.errorMessage })
      .from(signBulkSendRows)
      .where(eq(signBulkSendRows.jobId, jobId))
      .orderBy(signBulkSendRows.rowNumber);

    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "failed")).toBe(true);
    expect(rows[0]!.errorMessage).toMatch(/missing name/i);
    expect(rows[1]!.errorMessage).toMatch(/invalid email/i);
  }, 60_000);

  /** The progress endpoint has to agree with the rows, or it is decoration. */
  it("reports truthful progress through the API", async () => {
    const res = await request(seeded.app.getHttpServer())
      .get(`/sign/bulk-send/jobs/${jobId}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.job).toMatchObject({ status: "completed", totalCount: 2, failedCount: 2 });
  }, 60_000);
});
