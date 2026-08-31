import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { PayslipBulkPublisherService } from "./payslip-bulk-publisher.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { StorageService } from "../../storage/storage.service";
import type { PayrollNotificationsService } from "../insights/payroll-notifications.service";
import type { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import type { EmploymentFactsService } from "../../directory/employment-facts.service";

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

describe("PayslipBulkPublisherService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const RUN_ID = 5;
  const ACTOR_ID = "user-actor";

  function makeDb(runRow: unknown): { db: Db; findRun: jest.Mock } {
    const findRun = jest.fn().mockResolvedValue(runRow);
    const db = {
      query: {
        payrollRuns: { findFirst: findRun },
        payslipTemplates: { findFirst: jest.fn().mockResolvedValue(null) },
        organizations: { findFirst: jest.fn().mockResolvedValue(null) },
        payslipPublications: { findMany: jest.fn().mockResolvedValue([]) },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([]),
        }),
      }),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          onConflictDoUpdate: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([]),
          }),
        }),
      }),
      transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({
        update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }),
        insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
      })),
    } as unknown as Db;
    return { db, findRun };
  }

  const audit = { log: jest.fn() } as unknown as AuditService;
  const storage = { isConfigured: jest.fn().mockReturnValue(false) } as unknown as StorageService;
  const notifications = { notifyPayslipPublished: jest.fn() } as unknown as PayrollNotificationsService;
  const dispatch = { emit: jest.fn() } as unknown as NotificationDispatchService;
  const efService = {} as unknown as EmploymentFactsService;

  it("throws NotFoundException when run belongs to a different org — cross-tenant isolation", async () => {
    const { db, findRun } = makeDb(null);
    const svc = new PayslipBulkPublisherService(db, audit, storage, notifications, dispatch, efService);

    await expect(svc.publish(ATTACKER_ORG, RUN_ID, ACTOR_ID)).rejects.toThrow(NotFoundException);

    const callValues = sqlValues(findRun.mock.calls[0]?.[0]?.where);
    expect(callValues).toContain(ATTACKER_ORG);
    expect(callValues).toContain(RUN_ID);
  });

  it("org predicate gates the run lookup — run in victim org not visible to attacker org", async () => {
    const victimRunForAttacker = null;
    const { db, findRun } = makeDb(victimRunForAttacker);
    const svc = new PayslipBulkPublisherService(db, audit, storage, notifications, dispatch, efService);

    await expect(svc.publish(ATTACKER_ORG, RUN_ID, ACTOR_ID)).rejects.toThrow(NotFoundException);

    const callValues = sqlValues(findRun.mock.calls[0]?.[0]?.where);
    expect(callValues).toContain(ATTACKER_ORG);
  });
});
