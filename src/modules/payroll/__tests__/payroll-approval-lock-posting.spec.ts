import { ApprovalActionsService } from "../payout/approval-actions.service";
import { LockingService } from "../payout/locking.service";
import { PAYROLL_RUN_POSTING_INTENT_EVENT } from "../payout/payroll-posting-intent.consumer";
import type { Db } from "../../../db/drizzle.module";

const ORG_ID = "org-approval-lock";
const RUN_ID = 77;
const MONTH = "2026-08";
const SUBMITTER = "u-submitter";
const APPROVER = "u-approver";
const APPROVAL_ID = 5;

interface Captured {
  outboxRows: Record<string, unknown>[];
  runUpdates: Record<string, unknown>[];
}

function makeTx(captured: Captured) {
  const insert = jest.fn().mockImplementation((table: unknown) => ({
    values: jest.fn().mockImplementation((rows: unknown) => {
      const name = String((table as { [k: symbol]: unknown })?.constructor?.name ?? "");
      void name;
      const list = Array.isArray(rows) ? rows : [rows];
      for (const row of list) {
        const record = row as Record<string, unknown>;
        if (typeof record.eventType === "string") captured.outboxRows.push(record);
      }
      return {
        onConflictDoUpdate: jest.fn().mockResolvedValue([]),
        onConflictDoNothing: jest.fn().mockResolvedValue([]),
        returning: jest.fn().mockResolvedValue([]),
      };
    }),
  }));

  const update = jest.fn().mockReturnValue({
    set: jest.fn().mockImplementation((patch: Record<string, unknown>) => {
      captured.runUpdates.push(patch);
      return {
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ id: RUN_ID }]),
        }),
      };
    }),
  });

  return {
    query: { payrollRunEmployees: { findFirst: jest.fn().mockResolvedValue(null) } },
    insert,
    update,
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
      }),
    }),
  };
}

function makeApprovalService(captured: Captured) {
  const run = {
    id: RUN_ID,
    orgId: ORG_ID,
    status: "PENDING_APPROVAL",
    month: MONTH,
    grossTotal: "500000",
    deductionTotal: "50000",
    netTotal: "400000",
    employerCostTotal: "20000",
    policyVersion: { toggles: null },
  };

  let selectCall = 0;
  const db = {
    query: {
      payrollApprovals: {
        findFirst: jest.fn().mockResolvedValue({
          id: APPROVAL_ID,
          runId: RUN_ID,
          orgId: ORG_ID,
          status: "PENDING",
          requiredPermission: "payroll:runs:approve",
        }),
      },
      payrollRuns: { findFirst: jest.fn().mockResolvedValue(run) },
      organizationMembers: { findFirst: jest.fn().mockResolvedValue({ isOwner: true }) },
      payrollRunEvents: {
        findFirst: jest.fn().mockResolvedValue({ actorId: SUBMITTER, type: "APPROVAL_SUBMITTED" }),
      },
    },
    select: jest.fn().mockImplementation(() => {
      const idx = selectCall++;
      const rows =
        idx === 0
          ? [
              {
                id: APPROVAL_ID,
                status: "PENDING",
                requiredPermission: "payroll:runs:approve",
                stageName: "Finance",
              },
            ]
          : [
              {
                id: 99,
                orgId: ORG_ID,
                userId: APPROVER,
                role: "MEMBER",
                isOwner: true,
                status: "ACTIVE",
              },
            ];
      return {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(rows) }),
            limit: jest.fn().mockResolvedValue(rows),
          }),
        }),
      };
    }),
    transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(makeTx(captured)),
    ),
  } as unknown as Db;

  const locking = new LockingService(
    db,
    { log: jest.fn() } as never,
    { postPayrollLock: jest.fn().mockResolvedValue(undefined) } as never,
  );

  const service = new ApprovalActionsService(
    db,
    { resolveUserPermissions: jest.fn().mockResolvedValue(new Map()) } as never,
    { notifyApprovalPending: jest.fn().mockResolvedValue(undefined) } as never,
    { log: jest.fn() } as never,
    { resolveApprovers: jest.fn().mockResolvedValue([]) } as never,
    locking,
  );

  return { service, db };
}

describe("approval auto-lock commits the Accounting posting intent", () => {
  it("emits payroll.run.posting-intent on the approval transaction when lockAfterApproval is on by default", async () => {
    const captured: Captured = { outboxRows: [], runUpdates: [] };
    const { service } = makeApprovalService(captured);

    const result = await service.approveStage(ORG_ID, APPROVER, RUN_ID, APPROVAL_ID);

    expect(result.runStatus).toBe("LOCKED");
    const intents = captured.outboxRows.filter(
      (row) => row.eventType === PAYROLL_RUN_POSTING_INTENT_EVENT,
    );
    expect(intents).toHaveLength(1);
    expect(intents[0]?.organizationId).toBe(ORG_ID);
    expect(intents[0]?.aggregateId).toBe(String(RUN_ID));
  });

  it("marks the run posting_state pending so an unposted run is visible", async () => {
    const captured: Captured = { outboxRows: [], runUpdates: [] };
    const { service } = makeApprovalService(captured);

    await service.approveStage(ORG_ID, APPROVER, RUN_ID, APPROVAL_ID);

    const lockPatch = captured.runUpdates.find((patch) => patch.status === "LOCKED");
    expect(lockPatch).toBeDefined();
    expect(lockPatch?.postingState).toBe("pending");
    expect(lockPatch?.approvedAt).toBeInstanceOf(Date);
  });
});
