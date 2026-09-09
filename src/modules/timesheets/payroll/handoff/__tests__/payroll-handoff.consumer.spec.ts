import { PayrollHandoffConsumer } from "../payroll-handoff.consumer";
import { RecordingPayrollHandoffAdapter } from "../recording-handoff.adapter";
import { TIMESHEET_EVENTS, payrollHandoffPayloadSchema } from "../handoff.schemas";
import { OutboxConsumerRegistry, type OutboxEventRow } from "../../../../../common/outbox/outbox-consumer.registry";
import type { Db } from "../../../../../db/drizzle.module";
import type { TimesheetPayrollHandoffPort } from "../handoff.port";
import type { PayrollHandoffPayload } from "../handoff.schemas";

/**
 * These are unit tests and they cannot prove the seam works end to end — the
 * chain from a committed export through the publisher to the port needs a real
 * database and is covered separately. What they can prove is the part that is
 * pure decision: which event this consumer answers to, that it registers
 * itself at all, the exact shape it hands the port, and that it fails loudly
 * rather than quietly on the two things that can go wrong.
 *
 * The registration test is not ceremony. The publisher throws on an event type
 * with no consumer and sends the throw down the retry and dead-letter path, so
 * a consumer that exists but never registers is worse than no consumer: every
 * payroll export would dead-letter.
 */

const SNAPSHOT_ROW = {
  userId: "u1",
  employeeName: "Asha",
  employeeEmail: "asha@example.test",
  regularHours: 38,
  overtimeHours: 2,
  holidayHours: 0,
  weekendHours: 0,
  leaveDays: 0,
  billableHours: 32,
  nonBillableHours: 8,
  totalPayableHours: 40,
  entryCount: 5,
};

const EXPORT_ROW = {
  id: 7,
  dateRangeStart: "2026-09-01",
  dateRangeEnd: "2026-09-15",
  snapshot: [SNAPSHOT_ROW],
  filters: { mapping: { provider: "GENERIC", columns: [] } },
  entryCount: 5,
  totalHours: "40.00",
  createdAt: new Date("2026-09-16T04:00:00.000Z"),
};

function dbReturning(rows: unknown[]): Db {
  return {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => rows }) }),
    }),
  } as unknown as Db;
}

const EVENT: OutboxEventRow = {
  organizationId: "org-1",
  eventId: "11111111-1111-4111-8111-111111111111",
  eventType: TIMESHEET_EVENTS.payrollExportReady,
  payload: {
    organization_id: "org-1",
    export_id: 7,
    period_start: "2026-09-01",
    period_end: "2026-09-15",
    entry_count: 5,
    worker_count: 1,
    total_hours: "40.00",
    format: "CSV",
    actor_user_id: "u-actor",
  },
} as unknown as OutboxEventRow;

function capturingPort() {
  const seen: PayrollHandoffPayload[] = [];
  const port: TimesheetPayrollHandoffPort = {
    deliver: async (payload) => {
      seen.push(payload);
    },
    /** Not exercised here; the ack consumer has its own spec. */
    acknowledged: async () => undefined,
  };
  return { port, seen };
}

describe("PayrollHandoffConsumer", () => {
  it("registers itself, because an unregistered consumer dead-letters every export", () => {
    const registry = new OutboxConsumerRegistry();
    const { port } = capturingPort();
    const consumer = new PayrollHandoffConsumer(dbReturning([EXPORT_ROW]), port, registry);

    consumer.onModuleInit();

    expect(registry.get(TIMESHEET_EVENTS.payrollExportReady)).toBe(consumer);
  });

  it("hands the port a payload that satisfies the published contract", async () => {
    const { port, seen } = capturingPort();
    const consumer = new PayrollHandoffConsumer(
      dbReturning([EXPORT_ROW]),
      port,
      new OutboxConsumerRegistry(),
    );

    await consumer.handle(EVENT);

    expect(seen).toHaveLength(1);
    /** Parsed, not eyeballed: the contract is the assertion. */
    expect(() => payrollHandoffPayloadSchema.parse(seen[0])).not.toThrow();
    expect(seen[0]).toMatchObject({
      organizationId: "org-1",
      exportId: 7,
      periodStart: "2026-09-01",
      periodEnd: "2026-09-15",
      totalHours: 40,
      currency: null,
      ackPath: "timesheets/payroll/exports/7/ack",
    });
    expect(seen[0]!.rows).toEqual([SNAPSHOT_ROW]);
  });

  it("gives every retry of one export the same idempotency key", async () => {
    const { port, seen } = capturingPort();
    const consumer = new PayrollHandoffConsumer(
      dbReturning([EXPORT_ROW]),
      port,
      new OutboxConsumerRegistry(),
    );

    await consumer.handle(EVENT);
    await consumer.handle(EVENT);

    expect(seen[0]!.idempotencyKey).toBe(seen[1]!.idempotencyKey);
    /** And it names the event, so a different export cannot collide with it. */
    expect(seen[0]!.idempotencyKey).toContain(EVENT.eventId);
  });

  it("throws when the export is gone, so the failure reaches the outbox", async () => {
    const { port, seen } = capturingPort();
    const consumer = new PayrollHandoffConsumer(dbReturning([]), port, new OutboxConsumerRegistry());

    await expect(consumer.handle(EVENT)).rejects.toThrow(/payroll export 7 .* is gone/);
    expect(seen).toHaveLength(0);
  });

  it("throws on a payload that does not match the event schema rather than guessing", async () => {
    const { port, seen } = capturingPort();
    const consumer = new PayrollHandoffConsumer(
      dbReturning([EXPORT_ROW]),
      port,
      new OutboxConsumerRegistry(),
    );
    const malformed = { ...EVENT, payload: { export_id: "seven" } } as unknown as OutboxEventRow;

    await expect(consumer.handle(malformed)).rejects.toThrow(/does not match its schema/);
    expect(seen).toHaveLength(0);
  });
});

describe("RecordingPayrollHandoffAdapter", () => {
  const payload: PayrollHandoffPayload = {
    organizationId: "org-1",
    exportId: 7,
    periodStart: "2026-09-01",
    periodEnd: "2026-09-15",
    currency: null,
    entryCount: 5,
    totalHours: 40,
    mapping: null,
    rows: [SNAPSHOT_ROW],
    idempotencyKey: "outbox:org-1:timesheets-payroll-handoff:e1",
    ackPath: "timesheets/payroll/exports/7/ack",
    exportedAt: "2026-09-16T04:00:00.000Z",
  };

  it("says out loud that nothing consumed the handoff", async () => {
    const adapter = new RecordingPayrollHandoffAdapter();
    const logged: string[] = [];
    jest
      .spyOn(adapter["logger"], "log")
      .mockImplementation((message: unknown) => void logged.push(String(message)));

    await adapter.deliver(payload);

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("not delivered");
    expect(logged[0]).toContain("export=7");
  });

  it("rejects a payload that breaks the contract instead of logging a success", async () => {
    const adapter = new RecordingPayrollHandoffAdapter();
    const broken = { ...payload, exportId: -1 } as PayrollHandoffPayload;

    await expect(adapter.deliver(broken)).rejects.toThrow();
  });
});
