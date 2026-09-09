import request from "supertest";
import { and, eq } from "drizzle-orm";
import { orgModules, outboxEvents, timesheets as timesheetEntries } from "src/db/schema";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";
import { TIMESHEET_PAYROLL_HANDOFF_PORT } from "src/modules/timesheets/payroll/handoff/handoff.port";
import {
  TIMESHEET_EVENTS,
  payrollHandoffPayloadSchema,
  type PayrollHandoffPayload,
} from "src/modules/timesheets/payroll/handoff/handoff.schemas";

/**
 * The payroll handoff chain, end to end, against a real database under RLS.
 *
 * The unit spec next door owns the consumer's decisions. This file owns the
 * only question those cannot answer: does the chain actually run?
 *
 * That distinction is not academic here. The inventory webhook emitter had
 * nine green unit suites over it while no webhook had ever been enqueued,
 * because the defect lived in the seam between a statement and a real index.
 * The seams in this chain are of the same kind and each one is silent when it
 * breaks:
 *
 *   1. the emit is inside the export transaction, so an export that commits
 *      without its event, or an event that survives a rollback, is a bug no
 *      unit test with a stubbed `tx` can see;
 *   2. the publisher throws on an event type with no registered consumer, and
 *      the throw goes to the retry and dead-letter path — a consumer that
 *      exists but never registers dead-letters every export;
 *   3. the consumer reads `timesheet_exports` under the application role,
 *      where a read with no tenant context raises rather than returning empty.
 *
 * So this asserts on delivery state, not on absence of error: an event that
 * ends DEAD is the failure this file exists to catch, and it looks exactly
 * like a passing test if you only assert the export returned 201.
 *
 * Run with:
 *   NODE_OPTIONS=--max-old-space-size=12288 \
 *   APP_DATABASE_URL=postgres://streamline_app:...@host/db \
 *   CRON_SECRET=... pnpm test:e2e:seeded --testPathPattern="timesheets-payroll-handoff"
 */

const WINDOW_START = "2026-03-02";
const WINDOW_END = "2026-03-06";

describe(`${SEEDED_HARNESS} payroll handoff — an export reaches the port, not the dead-letter queue`, () => {
  let seeded: SeededE2eApp;
  let fixture: SeededFixture;
  let token: string;
  let delivered: PayrollHandoffPayload[];

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    fixture = await seedOrg(seeded.seedDb)
      .addMember("payroll-admin", {
        permissionKeys: ["timesheets:payroll:export", "timesheets:payroll:view"],
      })
      .build();
    /**
     * Both, and the second one is the interesting one.
     *
     * Every controller in `modules/timesheets` — all thirteen, including this
     * one — carries `@RequireModule("build")`, while the module registry
     * declares `timesheets` as its own plan-gated module with its own route
     * and cache namespace. Enabling only `timesheets` here produced 402 on the
     * export; adding `build` is what makes it reachable. That is recorded as a
     * finding rather than fixed, because flipping the decorator would revoke
     * access from any organisation that has Build and not Timesheets, which is
     * not a call this pack gets to make.
     */
    await seeded.seedDb
      .insert(orgModules)
      .values([
        { orgId: fixture.orgId, moduleKey: "timesheets", enabled: true },
        { orgId: fixture.orgId, moduleKey: "build", enabled: true },
      ])
      .onConflictDoNothing();

    const admin = fixture.members["payroll-admin"];
    if (!admin) throw new Error("fixture member 'payroll-admin' missing");
    token = await signSeededToken(admin.userId, fixture.orgId);

    /**
     * Approved, unprocessed hours — the only rows `runExport` considers.
     * Two days so the export has something to total rather than a single row
     * that could pass by coincidence.
     */
    await seeded.seedDb.insert(timesheetEntries).values([
      {
        orgId: fixture.orgId,
        userId: admin.userId,
        userMembershipId: admin.membershipId,
        date: WINDOW_START,
        hours: "8.00",
        description: "handoff probe day one",
        status: "APPROVED",
        payrollStatus: "UNPROCESSED",
        isBillable: true,
      },
      {
        orgId: fixture.orgId,
        userId: admin.userId,
        userMembershipId: admin.membershipId,
        date: WINDOW_END,
        hours: "6.50",
        description: "handoff probe day two",
        status: "APPROVED",
        payrollStatus: "UNPROCESSED",
        isBillable: false,
      },
    ]);

    /**
     * The bound adapter is spied rather than replaced, so the assertion is
     * about the port the application actually wires — a substituted provider
     * would prove the test's own wiring instead.
     */
    delivered = [];
    const port = seeded.app.get(TIMESHEET_PAYROLL_HANDOFF_PORT);
    jest.spyOn(port, "deliver").mockImplementation(async (payload: PayrollHandoffPayload) => {
      delivered.push(payload);
    });
  }, 180_000);

  afterAll(async () => {
    await fixture?.teardown();
    await seeded?.close();
  }, 60_000);

  let exportId = 0;

  it("commits the handoff event in the same transaction as the export", async () => {
    const res = await request(seeded.app.getHttpServer())
      .post("/timesheets/payroll/export")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", `handoff-${fixture.orgId}`)
      .send({ start: WINDOW_START, end: WINDOW_END, format: "CSV" });

    expect(res.status).toBe(201);
    exportId = res.body.export.id;
    expect(exportId).toBeGreaterThan(0);

    const rows = await seeded.seedDb
      .select({
        id: outboxEvents.outboxEventId,
        aggregateId: outboxEvents.aggregateId,
        deliveryState: outboxEvents.deliveryState,
        payload: outboxEvents.payload,
      })
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.organizationId, fixture.orgId),
          eq(outboxEvents.eventType, TIMESHEET_EVENTS.payrollExportReady),
        ),
      );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.aggregateId).toBe(String(exportId));
    expect(rows[0]!.payload).toMatchObject({
      export_id: exportId,
      period_start: WINDOW_START,
      period_end: WINDOW_END,
      worker_count: 1,
      entry_count: 2,
    });
  }, 120_000);

  it("delivers it to the bound port when the worker runs, and does not dead-letter", async () => {
    /**
     * The lease is shared, so a worker run can legitimately answer
     * `{ skipped: true }` while another suite holds it. Waiting the skip out
     * is the difference between a real assertion and one that passes on a
     * 200 that did nothing.
     */
    let ran = false;
    for (let attempt = 0; attempt < 10 && !ran; attempt++) {
      const res = await request(seeded.app.getHttpServer())
        .post("/cron/outbox-events-worker")
        .set("Authorization", `Bearer ${process.env.CRON_SECRET ?? ""}`)
        .send({});
      expect(res.status).toBe(200);
      if (res.body?.skipped !== true) ran = true;
      else await new Promise((r) => setTimeout(r, 3_000));
    }
    expect(ran).toBe(true);

    const [row] = await seeded.seedDb
      .select({
        deliveryState: outboxEvents.deliveryState,
        retryCount: outboxEvents.retryCount,
        lastError: outboxEvents.lastError,
      })
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.organizationId, fixture.orgId),
          eq(outboxEvents.eventType, TIMESHEET_EVENTS.payrollExportReady),
        ),
      );

    /** Reported before the assertion, so a failure names the reason. */
    if (row?.deliveryState !== "DELIVERED") {
      throw new Error(
        `handoff event is ${row?.deliveryState} after ${row?.retryCount} retries: ${row?.lastError}`,
      );
    }
    expect(row.deliveryState).toBe("DELIVERED");
  }, 180_000);

  it("hands the port the export's real numbers, in the published shape", () => {
    expect(delivered).toHaveLength(1);
    const payload = delivered[0]!;

    expect(() => payrollHandoffPayloadSchema.parse(payload)).not.toThrow();
    expect(payload).toMatchObject({
      organizationId: fixture.orgId,
      exportId,
      periodStart: WINDOW_START,
      periodEnd: WINDOW_END,
      currency: null,
      entryCount: 2,
      totalHours: 14.5,
      ackPath: `timesheets/payroll/exports/${exportId}/ack`,
    });
    /** 8.00 billable + 6.50 non-billable, kept apart rather than summed away. */
    expect(payload.rows).toHaveLength(1);
    expect(payload.rows[0]).toMatchObject({
      billableHours: 8,
      nonBillableHours: 6.5,
      totalPayableHours: 14.5,
    });
  });

  it("marks the exported hours so a second export cannot double-hand them off", async () => {
    const rows = await seeded.seedDb
      .select({ payrollStatus: timesheetEntries.payrollStatus })
      .from(timesheetEntries)
      .where(eq(timesheetEntries.orgId, fixture.orgId));

    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.payrollStatus === "EXPORTED")).toBe(true);
  }, 60_000);
});
