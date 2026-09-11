import { randomUUID } from "node:crypto";
import request from "supertest";
import { and, desc, eq } from "drizzle-orm";
import {
  crmReportDefinitions,
  crmReportScheduleRecipients,
  crmReportSchedules,
  emailOutbox,
  orgModules,
  outboxEvents,
} from "src/db/schema";
import { businessParties } from "src/db/schema/party";
import { ReportSchedulesService, REPORT_SCHEDULE_DUE } from "src/modules/reporting/report-schedules.service";
import { ReportScheduleConsumer } from "src/modules/reporting/report-schedule.consumer";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * CRM-P2-08. A saved report that arrives without anybody asking.
 *
 * The thing worth proving is the seam, not the CRUD. The sweep advances
 * `next_run_at` and writes the outbox event in one transaction, and the
 * consumer does everything after that — running the report and posting the mail
 * inside the sweep would lose both if the process died between them. Two
 * failures follow from getting that ordering wrong and neither is visible from
 * a green request: an emit without the advance sends the same report on every
 * tick, and an advance without the emit silently skips a period. The third test
 * here is the one that would notice.
 *
 * The other load-bearing claim is `run_as_user_id`. A schedule has no requester
 * when it fires, so it names one, and the run carries that person's permissions
 * and DataScope. If it did not, a schedule would be a way to read rows the
 * person who created it could not, and a leaver's report would keep arriving
 * after their access was withdrawn.
 *
 * Run with:
 *   DATABASE_URL=postgres://owner@host/db \
 *   APP_DATABASE_URL=postgres://streamline_app@host/db \
 *   node --max-old-space-size=12288 ./node_modules/jest/bin/jest.js \
 *     --config ./jest-e2e-seeded.json --forceExit --runInBand \
 *     --testPathPattern=crm-report-schedules
 */

const ANALYST_KEYS = [
  "crm:reporting:view",
  "crm:reporting:manage",
  "crm:reporting:run",
  "party:parties:view",
] as const;

/**
 * Everything reporting needs and nothing that lets the rows be read — the shape
 * an authority takes once somebody's access to a source has been withdrawn.
 */
const REPORTING_ONLY_KEYS = [
  "crm:reporting:view",
  "crm:reporting:manage",
  "crm:reporting:run",
] as const;

describe(`${SEEDED_HARNESS} a saved report that arrives on a timetable`, () => {
  let seeded: SeededE2eApp;
  let fixture: SeededFixture;
  let schedules: ReportSchedulesService;
  let consumer: ReportScheduleConsumer;
  let analystToken = "";
  let analystUserId = "";
  let reportDefinitionId = "";
  let reportScheduleId = "";

  const recipients = ["ops@test.invalid", "finance@test.invalid"];
  const http = () => request(seeded.app.getHttpServer());

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
      value: "Schedule probe",
    },
    groupBy: ["industry"],
    limit: 100,
  };

  /** Reaches back in time so the next sweep finds it, without waiting for a day. */
  const makeDue = () =>
    seeded.seedDb
      .update(crmReportSchedules)
      .set({ nextRunAt: new Date(Date.now() - 60_000) })
      .where(eq(crmReportSchedules.reportScheduleId, reportScheduleId));

  const dueEvents = () =>
    seeded.seedDb
      .select({
        eventId: outboxEvents.eventId,
        aggregateId: outboxEvents.aggregateId,
        payload: outboxEvents.payload,
        organizationId: outboxEvents.organizationId,
      })
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.organizationId, fixture.orgId),
          eq(outboxEvents.eventType, REPORT_SCHEDULE_DUE),
        ),
      );

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    fixture = await seedOrg(seeded.seedDb)
      .addMember("analyst", { permissionKeys: [...ANALYST_KEYS] })
      /** Holds the reporting keys and not the source's own. See the last test. */
      .addMember("leaver", { permissionKeys: [...REPORTING_ONLY_KEYS] })
      .build();
    schedules = seeded.app.get(ReportSchedulesService);
    consumer = seeded.app.get(ReportScheduleConsumer);

    analystUserId = fixture.members["analyst"]!.userId;
    analystToken = await signSeededToken(seeded, analystUserId, fixture.orgId);

    await seeded.seedDb
      .insert(orgModules)
      .values({ orgId: fixture.orgId, moduleKey: "crm", enabled: true })
      .onConflictDoNothing();

    for (const industry of ["Textiles", "Textiles", "Logistics"])
      await seeded.seedDb.insert(businessParties).values({
        partyId: randomUUID(),
        organizationId: fixture.orgId,
        name: `Schedule probe ${randomUUID().slice(0, 8)}`,
        industry,
      });

    const created = await http()
      .post("/crm/reporting/definitions")
      .set("Authorization", `Bearer ${analystToken}`)
      .send({ name: `Parties by industry ${randomUUID().slice(0, 8)}`, query })
      .expect(201);
    reportDefinitionId = (created.body.data ?? created.body).reportDefinitionId;
  }, 240_000);

  afterAll(async () => {
    if (fixture) {
      await seeded.seedDb
        .delete(emailOutbox)
        .where(eq(emailOutbox.organizationId, fixture.orgId));
      await seeded.seedDb
        .delete(outboxEvents)
        .where(eq(outboxEvents.organizationId, fixture.orgId));
      await seeded.seedDb
        .delete(crmReportScheduleRecipients)
        .where(eq(crmReportScheduleRecipients.organizationId, fixture.orgId));
      await seeded.seedDb
        .delete(crmReportSchedules)
        .where(eq(crmReportSchedules.organizationId, fixture.orgId));
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

  it("schedules a saved report, in the future and under its author's authority", async () => {
    const response = await http()
      .post("/crm/reporting/schedules")
      .set("Authorization", `Bearer ${analystToken}`)
      .send({ reportDefinitionId, cadence: "daily", hourOfDay: 7, recipients })
      .expect(201);

    const body = response.body.data ?? response.body;
    reportScheduleId = body.reportScheduleId;

    expect(body.recipients).toEqual(recipients);
    /** Strictly future, or the first sweep would fire it immediately. */
    expect(new Date(body.nextRunAt).getTime()).toBeGreaterThan(Date.now());
    /** The security decision: whose permissions the unattended run carries. */
    expect(body.runAsUserId).toBe(analystUserId);
  }, 120_000);

  it("claims a due schedule and emits, in one transaction", async () => {
    await makeDue();
    const result = await schedules.sweepDueSchedules();

    expect(result.claimed).toBeGreaterThanOrEqual(1);

    const [row] = await seeded.seedDb
      .select({
        nextRunAt: crmReportSchedules.nextRunAt,
        lastRunAt: crmReportSchedules.lastRunAt,
        lastError: crmReportSchedules.lastError,
      })
      .from(crmReportSchedules)
      .where(eq(crmReportSchedules.reportScheduleId, reportScheduleId));

    /** Advanced, so it is no longer due; and stamped, so an operator can see it ran. */
    expect(row!.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    expect(row!.lastRunAt).not.toBeNull();
    expect(row!.lastError).toBeNull();

    const events = await dueEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.aggregateId).toBe(reportScheduleId);
  }, 120_000);

  it("does not claim it again on the very next tick", async () => {
    /**
     * The failure this ordering exists to prevent. An emit that committed
     * without the advance would leave the row due, and the same report would go
     * out on every tick until the clock caught up.
     */
    const before = (await dueEvents()).length;
    await schedules.sweepDueSchedules();
    expect(await dueEvents()).toHaveLength(before);
  }, 120_000);

  it("can fire more than once, which is the whole point of a schedule", async () => {
    /**
     * The bug this test exists for, and it was real. `outbox_events` is unique
     * on (org, aggregate type, aggregate id, aggregate version), so emitting
     * version 1 on every firing succeeded the first time and violated the
     * constraint on every one after — a report that arrives once and then
     * silently never again, behind a sweep that logs the failure and moves on.
     * The run counter is incremented in the same statement that advances
     * `next_run_at`, so the version is monotonic by construction.
     */
    const before = (await dueEvents()).length;
    await makeDue();
    const result = await schedules.sweepDueSchedules();

    expect(result.failed).toBe(0);
    expect(await dueEvents()).toHaveLength(before + 1);

    const [row] = await seeded.seedDb
      .select({ runCount: crmReportSchedules.runCount })
      .from(crmReportSchedules)
      .where(eq(crmReportSchedules.reportScheduleId, reportScheduleId));
    expect(row!.runCount).toBe(2);
  }, 120_000);

  it("runs the report and queues one mail per recipient", async () => {
    const [event] = await seeded.seedDb
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.organizationId, fixture.orgId),
          eq(outboxEvents.eventType, REPORT_SCHEDULE_DUE),
        ),
      )
      .orderBy(desc(outboxEvents.occurredAt))
      .limit(1);

    /**
     * The tenant context the publisher establishes, restated here.
     *
     * `OutboxPublisherService` wraps every `consumer.handle` in
     * `runInNewTenantTransaction`, and it has to: the tables the consumer reads
     * are under row-level security, so a handler called with no context is
     * refused by the policy rather than by a bug in its own logic. Calling
     * `handle` bare from a spec would test a situation production never
     * produces, and would report an RLS refusal as a broken consumer.
     */
    await runInNewTenantTransaction(seeded.seedDb, fixture.orgId, () =>
      consumer.handle(event!),
    );

    const queued = await seeded.seedDb
      .select({
        toEmail: emailOutbox.toEmail,
        subject: emailOutbox.subject,
        html: emailOutbox.html,
      })
      .from(emailOutbox)
      .where(eq(emailOutbox.organizationId, fixture.orgId));

    /**
     * One per recipient, never one message addressed to all of them: a report's
     * distribution list is not something each recipient is entitled to read.
     */
    expect(queued).toHaveLength(recipients.length);
    expect(queued.map((row) => row.toEmail).sort()).toEqual([...recipients].sort());

    const [first] = queued;
    /** Two industries across three seeded parties, grouped. */
    expect(first!.subject).toContain("2 rows");
    expect(first!.html).toContain("Textiles");
    expect(first!.html).toContain("Logistics");
  }, 180_000);

  it("records a refusal on the row instead of failing silently", async () => {
    /**
     * The leaver case, which is the whole reason a schedule names an authority.
     *
     * Modelled by repointing `run_as_user_id` at somebody holding the reporting
     * keys and not the source's own, rather than by revoking the analyst's —
     * the seed helper's `grantPermissions` adds a role grant and cannot take one
     * away, so "revoking" would have left the original grant in place and this
     * test would have passed while proving nothing.
     *
     * With no authority over parties, `runDefinition` refuses. The schedule has
     * to say so on its own row, or an operator finds out when somebody asks
     * where last month's numbers are.
     */
    await seeded.seedDb
      .update(crmReportSchedules)
      .set({ runAsUserId: fixture.members["leaver"]!.userId })
      .where(eq(crmReportSchedules.reportScheduleId, reportScheduleId));

    await makeDue();
    await schedules.sweepDueSchedules();

    const [event] = await seeded.seedDb
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.organizationId, fixture.orgId),
          eq(outboxEvents.eventType, REPORT_SCHEDULE_DUE),
        ),
      )
      .orderBy(desc(outboxEvents.occurredAt))
      .limit(1);

    /** Rethrown, so the outbox retries and eventually dead-letters in public. */
    await expect(
      runInNewTenantTransaction(seeded.seedDb, fixture.orgId, () => consumer.handle(event!)),
    ).rejects.toThrow();

    const [row] = await seeded.seedDb
      .select({ lastError: crmReportSchedules.lastError })
      .from(crmReportSchedules)
      .where(eq(crmReportSchedules.reportScheduleId, reportScheduleId));

    expect(row!.lastError).toBeTruthy();
    /** And it names the missing authority, not just "failed". */
    expect(row!.lastError).toMatch(/party|permission|forbidden/i);
  }, 180_000);

  it("takes the recipient list with it when the schedule is deleted", async () => {
    await http()
      .delete(`/crm/reporting/schedules/${reportScheduleId}`)
      .set("Authorization", `Bearer ${analystToken}`)
      .expect(200);

    /**
     * Through the composite FK's ON DELETE CASCADE. It is CASCADE and not SET
     * NULL deliberately — a composite SET NULL nulls every column of the key
     * including the NOT NULL `organization_id`, which would abort the parent
     * delete rather than tidy the child.
     */
    const left = await seeded.seedDb
      .select({ email: crmReportScheduleRecipients.email })
      .from(crmReportScheduleRecipients)
      .where(eq(crmReportScheduleRecipients.reportScheduleId, reportScheduleId));

    expect(left).toHaveLength(0);
  }, 120_000);
});
