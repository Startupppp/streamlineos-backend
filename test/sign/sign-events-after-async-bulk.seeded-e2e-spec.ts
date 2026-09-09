import request from "supertest";
import { and, eq } from "drizzle-orm";
import {
  automationRules,
  automationRuns,
  orgModules,
  signBulkSendJobs,
  signTemplates,
  webhookEndpoints,
  webhookLogs,
} from "src/db/schema";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * SIGN-P1-06. Bulk send now finishes on the outbox worker instead of in the
 * request, so everything `emitBulkSendCompleted` fans out to has to survive
 * losing the request's tenant transaction.
 *
 * That is not a formality. `sign_bulk_send_*`, `webhook_endpoints`,
 * `automation_rules`, `push_subscriptions` and `notifications` are all behind
 * `tenant_isolation` with the *raising* accessor, `app.current_org_id()`. A
 * read with no tenant context does not come back empty — it throws. And every
 * one of these fan-outs is fire-and-forget, so each throw lands in a `.catch`
 * with nowhere to go. The failure mode is a feature that is configured, is
 * enabled, and never runs, with a green request in front of it.
 *
 * `emitBulkSendCompleted` has three fan-outs and they do not share a tenant
 * discipline:
 *
 *   webhooks.dispatch          opens its own tenant transaction
 *   automation.runAutomations  reads `this.db` with no tenant scope
 *   notifications.create       opens its own
 *
 * So this file asserts on the rows those fan-outs are supposed to leave
 * behind, from the worker, rather than on the emit call being made.
 *
 * The webhook endpoint deliberately points at an unresolvable host. The SSRF
 * guard blocks loopback and private space on purpose and has no test bypass,
 * so no local sink can ever be delivered to; what is provable offline is that
 * dispatch resolved its endpoints under a live tenant, reached delivery, and
 * recorded the attempt with the payload it was given. The HTTP send itself is
 * covered by ssrf-guard.spec and outbound-request.spec.
 *
 * Run with:
 *   DATABASE_URL=postgres://owner@host/db \
 *   APP_DATABASE_URL=postgres://streamline_app@host/db CRON_SECRET=... \
 *   node --max-old-space-size=12288 ./node_modules/jest/bin/jest.js \
 *     --config ./jest-e2e-seeded.json --forceExit --runInBand \
 *     --testPathPattern=sign-events-after-async-bulk
 */

const BULK_COMPLETED = "sign.bulk_send.completed";

describe(`${SEEDED_HARNESS} sign events still fire once bulk send is asynchronous`, () => {
  let seeded: SeededE2eApp;
  let fixture: SeededFixture;
  let token = "";
  let templateId = 0;
  let endpointId = 0;
  let ruleId = 0;
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

    const [template] = await seeded.seedDb
      .insert(signTemplates)
      .values({
        orgId: fixture.orgId,
        name: "Bulk event probe",
        status: "published",
        ownerUserId: fixture.members["sender"]!.userId,
        templateJson: {
          roles: [{ roleName: "Signer", recipientType: "signer", routingOrder: 1, authMethod: "email_link" }],
          documents: [],
          fields: [],
        },
      })
      .returning({ id: signTemplates.id });
    templateId = template!.id;

    /**
     * `.invalid` is reserved by RFC 2606 and never resolves, so the guard
     * rejects it as `unresolvable-host` without any network egress from the
     * test. A blocked endpoint is still a *recorded* delivery attempt, which
     * is the half this test is about.
     */
    const [endpoint] = await seeded.seedDb
      .insert(webhookEndpoints)
      .values({
        orgId: fixture.orgId,
        url: "https://sink.invalid/sign-hook",
        secret: "s".repeat(64),
        description: "SIGN-P1-06 probe",
        events: [BULK_COMPLETED],
        isActive: true,
        createdBy: fixture.members["sender"]!.userId,
      })
      .returning({ id: webhookEndpoints.id });
    endpointId = endpoint!.id;

    /**
     * No conditions, so the rule matches whatever payload arrives: the
     * question is whether the automation engine is reached at all, not
     * whether its matcher works.
     */
    const [rule] = await seeded.seedDb
      .insert(automationRules)
      .values({
        orgId: fixture.orgId,
        name: "SIGN-P1-06 probe",
        triggerEvent: BULK_COMPLETED,
        conditions: [],
        actions: [
          {
            type: "notify_all",
            config: { title: "Bulk send finished", message: "A bulk send job completed" },
          },
        ],
        isEnabled: true,
        createdBy: fixture.members["sender"]!.userId,
      })
      .returning({ id: automationRules.id });
    ruleId = rule!.id;
  }, 240_000);

  afterAll(async () => {
    if (fixture) {
      await seeded.seedDb.delete(webhookLogs).where(eq(webhookLogs.orgId, fixture.orgId));
      await seeded.seedDb.delete(webhookEndpoints).where(eq(webhookEndpoints.orgId, fixture.orgId));
      await seeded.seedDb.delete(automationRuns).where(eq(automationRuns.orgId, fixture.orgId));
      await seeded.seedDb.delete(automationRules).where(eq(automationRules.orgId, fixture.orgId));
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
      if (res.body?.skipped !== true) return;
      await new Promise((r) => setTimeout(r, 3_000));
    }
  };

  /**
   * The fan-outs are not awaited by the worker, so the outbox call returning
   * does not mean they have finished. Poll rather than sleep a fixed amount:
   * a fixed sleep is either flaky or slow, and usually both.
   */
  const waitForRows = async <T>(read: () => Promise<T[]>, seconds = 20): Promise<T[]> => {
    for (let attempt = 0; attempt < seconds * 2; attempt++) {
      const rows = await read();
      if (rows.length > 0) return rows;
      await new Promise((r) => setTimeout(r, 500));
    }
    return read();
  };

  it("runs the job to completion on the worker", async () => {
    const res = await request(seeded.app.getHttpServer())
      .post("/sign/bulk-send/jobs")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", `bulk-events-${Date.now()}`)
      .send({
        templateId,
        columnMapping: { name: "name", email: "email" },
        rows: [{ name: "", email: "" }],
      });

    expect(res.status).toBe(201);
    jobId = res.body.job.id;

    await drainOutbox();

    const [job] = await seeded.seedDb
      .select({ status: signBulkSendJobs.status })
      .from(signBulkSendJobs)
      .where(eq(signBulkSendJobs.id, jobId));
    expect(job?.status).toBe("completed");
  }, 120_000);

  it("records the bulk-send webhook delivery, with its payload, from the worker", async () => {
    const logs = await waitForRows(() =>
      seeded.seedDb
        .select({
          event: webhookLogs.event,
          endpointId: webhookLogs.endpointId,
          payload: webhookLogs.payload,
          success: webhookLogs.success,
          responseBody: webhookLogs.responseBody,
        })
        .from(webhookLogs)
        .where(and(eq(webhookLogs.orgId, fixture.orgId), eq(webhookLogs.event, BULK_COMPLETED))),
    );

    expect(logs).toHaveLength(1);
    expect(logs[0]!.endpointId).toBe(endpointId);

    /**
     * The payload is the part that matters. A row written with the right
     * jobId and counts can only have come from `emitBulkSendCompleted` after
     * `finishJob` recomputed them — it could not have been produced by a
     * dispatch that failed to resolve its tenant.
     */
    expect(logs[0]!.payload).toMatchObject({ jobId, totalCount: 1, successCount: 0, failedCount: 1 });

    /** Blocked, not delivered — and honest about which. */
    expect(logs[0]!.success).toBe(false);
    expect(logs[0]!.responseBody).toBe("Blocked: unresolvable-host");
  }, 60_000);

  it("reaches the automation engine for the same event", async () => {
    const runs = await waitForRows(() =>
      seeded.seedDb
        .select({ ruleId: automationRuns.ruleId, status: automationRuns.status, payload: automationRuns.payload })
        .from(automationRuns)
        .where(and(eq(automationRuns.orgId, fixture.orgId), eq(automationRuns.triggerEvent, BULK_COMPLETED))),
    );

    expect(runs).toHaveLength(1);
    expect(runs[0]!.ruleId).toBe(ruleId);
    expect(runs[0]!.payload).toMatchObject({ jobId });
  }, 60_000);

  it("counts the automation run against the rule", async () => {
    const [rule] = await seeded.seedDb
      .select({ runCount: automationRules.runCount, lastRunAt: automationRules.lastRunAt })
      .from(automationRules)
      .where(eq(automationRules.id, ruleId));

    expect(rule?.runCount).toBe(1);
    expect(rule?.lastRunAt).not.toBeNull();
  }, 60_000);
});
