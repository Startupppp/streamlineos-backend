import { ZodError } from "zod";

import { PayrollAckConsumer } from "../payroll-ack.consumer";
import { RecordingPayrollHandoffAdapter } from "../recording-handoff.adapter";
import { TIMESHEET_EVENTS, payrollAckPayloadSchema } from "../handoff.schemas";
import { OutboxConsumerRegistry, type OutboxEventRow } from "../../../../../common/outbox/outbox-consumer.registry";
import type { TimesheetPayrollHandoffPort } from "../handoff.port";
import type { PayrollAckPayload, PayrollHandoffPayload } from "../handoff.schemas";

const EVENT: OutboxEventRow = {
  organizationId: "org-1",
  eventId: "22222222-2222-4222-8222-222222222222",
  eventType: TIMESHEET_EVENTS.payrollExportAcked,
  payload: {
    organization_id: "org-1",
    export_id: 7,
    status: "ACCEPTED",
    note: "loaded into the run",
    acked_at: "2026-09-16T05:00:00.000Z",
    actor_user_id: "u-payroll",
  },
} as unknown as OutboxEventRow;

function capturingPort() {
  const seen: PayrollAckPayload[] = [];
  const port: TimesheetPayrollHandoffPort = {
    deliver: async (_payload: PayrollHandoffPayload) => undefined,
    acknowledged: async (payload) => {
      seen.push(payload);
    },
  };
  return { port, seen };
}

describe("PayrollAckConsumer", () => {
  it("registers itself, or every acknowledgement dead-letters", () => {
    const registry = new OutboxConsumerRegistry();
    const consumer = new PayrollAckConsumer(capturingPort().port, registry);

    consumer.onModuleInit();

    expect(registry.get(TIMESHEET_EVENTS.payrollExportAcked)).toBe(consumer);
  });

  it("hands the port a payload matching the published contract", async () => {
    const { port, seen } = capturingPort();
    const consumer = new PayrollAckConsumer(port, new OutboxConsumerRegistry());

    await consumer.handle(EVENT);

    expect(seen).toHaveLength(1);
    expect(() => payrollAckPayloadSchema.parse(seen[0])).not.toThrow();
    expect(seen[0]).toMatchObject({
      organizationId: "org-1",
      exportId: 7,
      status: "ACCEPTED",
      note: "loaded into the run",
      ackBy: "u-payroll",
    });
  });

  it("reports the status the event recorded", async () => {
    const { port, seen } = capturingPort();
    const consumer = new PayrollAckConsumer(port, new OutboxConsumerRegistry());

    await consumer.handle(EVENT);
    await consumer.handle({
      ...EVENT,
      eventId: "33333333-3333-4333-8333-333333333333",
      payload: { ...(EVENT.payload as object), status: "REJECTED", note: null },
    } as unknown as OutboxEventRow);

    expect(seen.map((s) => s.status)).toEqual(["ACCEPTED", "REJECTED"]);
    expect(seen[1]!.note).toBeNull();
  });

  it("gives distinct acknowledgements distinct idempotency keys", async () => {
    const { port, seen } = capturingPort();
    const consumer = new PayrollAckConsumer(port, new OutboxConsumerRegistry());

    await consumer.handle(EVENT);
    await consumer.handle({ ...EVENT, eventId: "44444444-4444-4444-8444-444444444444" } as OutboxEventRow);

    expect(seen[0]!.idempotencyKey).not.toBe(seen[1]!.idempotencyKey);
  });

  it("gives every retry of one acknowledgement the same key", async () => {
    const { port, seen } = capturingPort();
    const consumer = new PayrollAckConsumer(port, new OutboxConsumerRegistry());

    await consumer.handle(EVENT);
    await consumer.handle(EVENT);

    expect(seen[0]!.idempotencyKey).toBe(seen[1]!.idempotencyKey);
  });

  it("throws on a payload that does not match its schema", async () => {
    const { port, seen } = capturingPort();
    const consumer = new PayrollAckConsumer(port, new OutboxConsumerRegistry());
    const malformed = { ...EVENT, payload: { export_id: 7, status: "MAYBE" } } as unknown as OutboxEventRow;

    await expect(consumer.handle(malformed)).rejects.toThrow(/does not match its schema/);
    expect(seen).toHaveLength(0);
  });
});

describe("RecordingPayrollHandoffAdapter.acknowledged", () => {
  const payload: PayrollAckPayload = {
    organizationId: "org-1",
    exportId: 7,
    status: "ACCEPTED",
    note: null,
    ackAt: "2026-09-16T05:00:00.000Z",
    ackBy: "u-payroll",
    idempotencyKey: "outbox:org-1:timesheets-payroll-ack:e1",
  };

  it("warns on a rejection and merely logs an acceptance", async () => {
    const adapter = new RecordingPayrollHandoffAdapter();
    const warned: string[] = [];
    const logged: string[] = [];
    jest.spyOn(adapter["logger"], "warn").mockImplementation((m: unknown) => void warned.push(String(m)));
    jest.spyOn(adapter["logger"], "log").mockImplementation((m: unknown) => void logged.push(String(m)));

    await adapter.acknowledged(payload);
    await adapter.acknowledged({ ...payload, status: "REJECTED", note: "bad account numbers" });

    expect(logged).toHaveLength(1);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("REJECTED");
    expect(warned[0]).toContain("bad account numbers");
  });

  it("rejects an acknowledgement that breaks the contract", async () => {
    const adapter = new RecordingPayrollHandoffAdapter();
    const refusal = await adapter
      .acknowledged({ ...payload, status: "MAYBE" } as unknown as PayrollAckPayload)
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(refusal).toBeInstanceOf(ZodError);
    expect((refusal as ZodError).issues.map((issue) => issue.path.join("."))).toContain("status");
  });
});
