import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.types";
import { BatchStatusService } from "./batch-status.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const rec = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(rec.queryChunks ? sqlValues(rec.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(rec, "value") ? sqlValues(rec.value, seen) : []),
  ];
}

const ATTACKER = "org-attacker";
const OWNER = "org-owner";

function makeTx() {
  const updateWhere = jest.fn().mockResolvedValue([]);
  const insertValues = jest.fn().mockResolvedValue([]);
  return {
    update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: updateWhere }) }),
    insert: jest.fn().mockReturnValue({ values: insertValues }),
    updateWhere,
  };
}

describe("BatchStatusService — cross-tenant isolation", () => {
  it("markSent: throws NotFoundException when batch belongs to a different org (deny)", async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const tx = makeTx();
    const db = {
      query: { payrollBankBatches: { findFirst } },
      transaction: jest.fn().mockImplementation((cb: (tx: unknown) => unknown) => cb(tx)),
    } as unknown as Db;
    const audit = { log: jest.fn() } as never;
    const payrollPosting = {} as never;
    const svc = new BatchStatusService(db, audit, payrollPosting);
    await expect(svc.markSent(ATTACKER, 1, "actor-1")).rejects.toThrow(NotFoundException);
    expect(findFirst).toHaveBeenCalled();
    const vals = sqlValues(findFirst.mock.calls[0]?.[0]?.where);
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("markSent: succeeds for the owning org and passes orgId through the transaction (control)", async () => {
    const findFirst = jest.fn().mockResolvedValue({ id: 1, status: "GENERATED", runId: 100 });
    const tx = makeTx();
    const db = {
      query: { payrollBankBatches: { findFirst } },
      transaction: jest.fn().mockImplementation((cb: (tx: unknown) => unknown) => cb(tx)),
    } as unknown as Db;
    const audit = { log: jest.fn() } as never;
    const payrollPosting = {} as never;
    const svc = new BatchStatusService(db, audit, payrollPosting);
    const result = await svc.markSent(OWNER, 1, "actor-1");
    expect(result.success).toBe(true);
    const vals = sqlValues(findFirst.mock.calls[0]?.[0]?.where);
    expect(vals).toContain(OWNER);
    expect(tx.update).toHaveBeenCalled();
  });
});
