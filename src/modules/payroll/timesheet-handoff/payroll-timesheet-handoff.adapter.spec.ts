import { PayrollTimesheetHandoffAdapter } from "./payroll-timesheet-handoff.adapter";
import type { PayrollAckPayload, PayrollHandoffPayload } from "../../timesheets/payroll/handoff/handoff.schemas";

function payload(over: Partial<PayrollHandoffPayload> = {}): PayrollHandoffPayload {
  return {
    organizationId: "org-1",
    exportId: 9,
    periodStart: "2026-09-01",
    periodEnd: "2026-09-07",
    currency: null,
    entryCount: 2,
    totalHours: 16,
    mapping: { provider: "GENERIC", columns: [] },
    rows: [
      {
        userId: "usr-1",
        employeeName: "Asha",
        employeeEmail: "asha@example.test",
        regularHours: 8,
        overtimeHours: 0,
        holidayHours: 0,
        weekendHours: 0,
        leaveDays: 0,
        billableHours: 8,
        nonBillableHours: 0,
        totalPayableHours: 8,
        entryCount: 1,
      },
    ],
    idempotencyKey: "outbox:org-1:payroll-handoff:evt-1",
    ackPath: "timesheets/payroll/exports/9/ack",
    exportedAt: "2026-09-08T00:00:00.000Z",
    ...over,
  };
}

function ack(over: Partial<PayrollAckPayload> = {}): PayrollAckPayload {
  return {
    organizationId: "org-1",
    exportId: 9,
    status: "ACCEPTED",
    ackBy: "usr-payroll",
    ackAt: "2026-09-08T01:00:00.000Z",
    note: null,
    idempotencyKey: "outbox:org-1:payroll-ack:evt-2",
    ...over,
  };
}

describe("PayrollTimesheetHandoffAdapter", () => {
  it("inserts a SUCCEEDED receipt for a new export and is a no-op on retry", async () => {
    const findFirst = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ status: "SUCCEEDED" });
    const values = jest.fn().mockResolvedValue([{ id: 1 }]);
    const db = {
      query: { payrollCommandReceipts: { findFirst } },
      insert: jest.fn().mockReturnValue({ values }),
    };
    const adapter = new PayrollTimesheetHandoffAdapter(db as never);

    await adapter.deliver(payload());
    await adapter.deliver(payload());

    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(values.mock.calls[0]![0]).toMatchObject({
      orgId: "org-1",
      command: "timesheet.handoff.deliver",
      idempotencyKey: "outbox:org-1:payroll-handoff:evt-1",
      status: "SUCCEEDED",
    });
  });

  it("records an acknowledgement on its own idempotency key", async () => {
    const findFirst = jest.fn().mockResolvedValue(undefined);
    const values = jest.fn().mockResolvedValue([{ id: 2 }]);
    const db = {
      query: { payrollCommandReceipts: { findFirst } },
      insert: jest.fn().mockReturnValue({ values }),
    };
    const adapter = new PayrollTimesheetHandoffAdapter(db as never);

    await adapter.acknowledged(ack({ status: "REJECTED", note: "hours mismatch" }));

    expect(values.mock.calls[0]![0]).toMatchObject({
      command: "timesheet.handoff.ack",
      idempotencyKey: "outbox:org-1:payroll-ack:evt-2",
      response: expect.objectContaining({ status: "REJECTED", note: "hours mismatch" }),
    });
  });
});
