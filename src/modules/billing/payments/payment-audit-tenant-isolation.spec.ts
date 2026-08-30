import type { Db } from "../../../db/drizzle.module";
import { PaymentAuditService } from "./payment-audit.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((i) => sqlValues(i, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("PaymentAuditService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const AUDIT_ROW = { id: 1, orgId: OWNER, action: "payment.created" };

  it("returns empty audit for a different org (cross-tenant isolation)", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const db = { query: { paymentAuditEvents: { findMany } }, insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }) } as unknown as Db;
    const svc = new PaymentAuditService(db);
    const result = await svc.listForOrg(ATTACKER);
    expect(result).toHaveLength(0);
    const call = findMany.mock.calls[0]?.[0];
    expect(sqlValues(call?.where)).toContain(ATTACKER);
  });

  it("returns audit events for the owning org (control — same-tenant)", async () => {
    const findMany = jest.fn().mockResolvedValue([AUDIT_ROW]);
    const db = { query: { paymentAuditEvents: { findMany } }, insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }) } as unknown as Db;
    const svc = new PaymentAuditService(db);
    const result = await svc.listForOrg(OWNER);
    expect(result).toHaveLength(1);
  });
});
