import type { Db } from "../../../db/drizzle.module";
import { PaymentManualMethodsService } from "./payment-manual-methods.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((i) => sqlValues(i, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("PaymentManualMethodsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const METHOD_ROW = { id: 1, orgId: OWNER, methodType: "bank_transfer" };

  it("returns empty list for a different org (cross-tenant isolation)", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const db = { query: { paymentManualMethods: { findMany, findFirst: jest.fn().mockResolvedValue(null) } } } as unknown as Db;
    const mockAudit = { log: jest.fn() } as any;
    const svc = new PaymentManualMethodsService(db, mockAudit);
    const result = await svc.list(ATTACKER);
    expect(result).toHaveLength(0);
    const call = findMany.mock.calls[0]?.[0];
    expect(sqlValues(call?.where)).toContain(ATTACKER);
  });

  it("returns methods for the owning org (control — same-tenant)", async () => {
    const findMany = jest.fn().mockResolvedValue([METHOD_ROW]);
    const db = { query: { paymentManualMethods: { findMany, findFirst: jest.fn().mockResolvedValue(null) } } } as unknown as Db;
    const mockAudit = { log: jest.fn() } as any;
    const svc = new PaymentManualMethodsService(db, mockAudit);
    const result = await svc.list(OWNER);
    expect(result).toHaveLength(1);
  });
});
