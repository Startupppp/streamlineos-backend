import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { PayrollInputAdjustmentsService } from "./payroll-input-adjustments.service";
import { HrAuditService } from "../core/hr-audit.service";
import type { SectionQueryInput } from "./dto/payroll-inputs.schemas";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((i) => sqlValues(i, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";

const QUERY_INPUT: SectionQueryInput = { limit: 50 };

function makeDb() {
  const periodsFindFirst = jest.fn().mockResolvedValue(null);
  const adjustmentsFindFirst = jest.fn().mockResolvedValue(null);
  const db = {
    query: {
      hrPayrollInputPeriods: { findFirst: periodsFindFirst },
      hrPayrollAdjustments: { findFirst: adjustmentsFindFirst },
    },
  } as unknown as Db;
  return { db, periodsFindFirst, adjustmentsFindFirst };
}

function makeService(db: Db) {
  return new PayrollInputAdjustmentsService(db, {} as unknown as HrAuditService);
}

describe("PayrollInputAdjustmentsService — cross-tenant isolation", () => {
  it("listAdjustments throws NotFoundException when period belongs to a different org (cross-tenant isolation)", async () => {
    const { db, periodsFindFirst } = makeDb();
    const svc = makeService(db);

    await expect(svc.listAdjustments(ATTACKER_ORG, 999, QUERY_INPUT)).rejects.toThrow(NotFoundException);

    expect(periodsFindFirst).toHaveBeenCalled();
    const whereArg = (periodsFindFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined)?.where;
    expect(sqlValues(whereArg)).toContain(ATTACKER_ORG);
  });

  it("approveAdjustment throws NotFoundException when adjustment belongs to a different org (cross-tenant isolation)", async () => {
    const { db, adjustmentsFindFirst } = makeDb();
    const svc = makeService(db);

    await expect(svc.approveAdjustment(ATTACKER_ORG, "actor-1", 888)).rejects.toThrow(NotFoundException);

    expect(adjustmentsFindFirst).toHaveBeenCalled();
    const whereArg = (adjustmentsFindFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined)?.where;
    expect(sqlValues(whereArg)).toContain(ATTACKER_ORG);
  });

  it("listAdjustments period lookup includes orgId in predicate and excludes the owning org (isolation boundary)", async () => {
    const { db, periodsFindFirst } = makeDb();
    const svc = makeService(db);

    await expect(svc.listAdjustments(ATTACKER_ORG, 999, QUERY_INPUT)).rejects.toThrow(NotFoundException);

    const whereArg = (periodsFindFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined)?.where;
    const vals = sqlValues(whereArg);
    expect(vals).toContain(ATTACKER_ORG);
    expect(vals).not.toContain(OWNER_ORG);
  });
});
