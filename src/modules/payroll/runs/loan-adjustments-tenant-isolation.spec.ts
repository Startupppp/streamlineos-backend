import type { Db } from "../../../db/drizzle.module";
import { LoanAdjustmentsService } from "./loan-adjustments.service";

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

describe("LoanAdjustmentsService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";
  const generate = { generateRun: jest.fn().mockResolvedValue(undefined) } as never;

  function makeDb(runRows: unknown[], loanRows: unknown[] = [], insertedRows: unknown[] = []) {
    const runLimit = jest.fn().mockResolvedValue(runRows);
    const runWhere = jest.fn().mockReturnValue({ limit: runLimit });
    const runFrom = jest.fn().mockReturnValue({ where: runWhere });

    const loanLimit = jest.fn().mockResolvedValue(loanRows);
    const loanWhere = jest.fn().mockReturnValue({ limit: loanLimit });
    const loanFrom = jest.fn().mockReturnValue({ where: loanWhere });

    const returning = jest.fn().mockResolvedValue(insertedRows);
    const values = jest.fn().mockReturnValue({ returning });
    const insert = jest.fn().mockReturnValue({ values });

    const select = jest.fn()
      .mockReturnValueOnce({ from: runFrom })
      .mockReturnValue({ from: loanFrom });

    return { db: { select, insert } as unknown as Db, runWhere };
  }

  it("returns not_found for createAdjustment when run belongs to a different org (cross-tenant isolation)", async () => {
    const { db, runWhere } = makeDb([]);
    const svc = new LoanAdjustmentsService(db, generate);
    const result = await svc.createAdjustment(ATTACKER_ORG, 99, "u1", { loanId: 1, type: "MANUAL", amount: 100, reason: "test" } as never);
    expect(result).toMatchObject({ ok: false, reason: "not_found" });
    expect(sqlValues(runWhere.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
  });

  it("processes adjustment for the owning org (same-tenant control)", async () => {
    const run = { id: 1, status: "DRAFT" };
    const loan = { id: 1, userId: "u1", status: "ACTIVE", orgId: OWNER_ORG };
    const inserted = { id: 10 };
    const { db } = makeDb([run], [loan], [inserted]);
    const svc = new LoanAdjustmentsService(db, generate);
    const result = await svc.createAdjustment(OWNER_ORG, 1, "u1", { loanId: 1, type: "MANUAL", amount: 100, reason: "test" } as never);
    expect(result).toMatchObject({ ok: true, id: 10 });
  });
});
