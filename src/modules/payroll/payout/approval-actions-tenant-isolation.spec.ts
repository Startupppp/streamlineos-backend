import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { ApprovalActionsService } from "./approval-actions.service";
import { LockingService } from "./locking.service";
import type { AccessService } from "../../access/access.service";
import type { PayrollNotificationsService } from "../insights/payroll-notifications.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { PayrollApproverResolverService } from "./payroll-approver-resolver.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

describe("ApprovalActionsService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const RUN_ID = 7;
  const APPROVAL_ID = 99;
  const USER_ID = "user-caller";

  function makeDb(approvalRow: unknown, runRow: unknown): { db: Db; findApproval: jest.Mock; findRun: jest.Mock } {
    const findApproval = jest.fn().mockResolvedValue(approvalRow);
    const findRun = jest.fn().mockResolvedValue(runRow);
    const db = {
      query: {
        payrollApprovals: { findFirst: findApproval },
        payrollRuns: { findFirst: findRun },
        organizationMembers: { findFirst: jest.fn().mockResolvedValue(null) },
        payrollRunEvents: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockResolvedValue([]),
          }),
        }),
      }),
      transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({
        update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }),
        insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
      })),
    } as unknown as Db;
    return { db, findApproval, findRun };
  }

  const access = { holds: jest.fn(), resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>()) } as unknown as AccessService;
  const notifications = { notifyApprovalPending: jest.fn() } as unknown as PayrollNotificationsService;
  const audit = { log: jest.fn() } as unknown as AuditService;
  const resolver = { resolveApprovers: jest.fn().mockResolvedValue([]) } as unknown as PayrollApproverResolverService;
  const locking = { commitLock: jest.fn().mockResolvedValue(undefined) } as unknown as LockingService;

  it("throws NotFoundException when approval belongs to a different org — cross-tenant isolation", async () => {
    const { db, findApproval, findRun } = makeDb(null, null);
    const svc = new ApprovalActionsService(db, access, notifications, audit, resolver, locking);

    await expect(svc.approveStage(ATTACKER_ORG, USER_ID, RUN_ID, APPROVAL_ID)).rejects.toThrow(NotFoundException);

    const approvalCallValues = sqlValues(findApproval.mock.calls[0]?.[0]?.where);
    expect(approvalCallValues).toContain(ATTACKER_ORG);
    const runCallValues = sqlValues(findRun.mock.calls[0]?.[0]?.where);
    expect(runCallValues).toContain(ATTACKER_ORG);
  });

  it("throws NotFoundException when rejection targets a different org's run — cross-tenant isolation", async () => {
    const { db, findApproval, findRun } = makeDb(null, null);
    const svc = new ApprovalActionsService(db, access, notifications, audit, resolver, locking);

    await expect(svc.rejectStage(ATTACKER_ORG, USER_ID, RUN_ID, APPROVAL_ID, "reason")).rejects.toThrow(NotFoundException);

    const approvalCallValues = sqlValues(findApproval.mock.calls[0]?.[0]?.where);
    expect(approvalCallValues).toContain(ATTACKER_ORG);
  });
});
