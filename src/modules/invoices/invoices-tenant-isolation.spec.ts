import type { Db } from "../../db/drizzle.module";
import { InvoicesService } from "./invoices.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((i) => sqlValues(i, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("InvoicesService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const INVOICE_ROW = { id: 1, orgId: OWNER, invoiceNumber: "INV-001", total: "500", status: "DRAFT" };

  it("returns empty invoices for a different org (cross-tenant isolation)", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const where = jest.fn().mockResolvedValue([{ count: 0 }]);
    const from = jest.fn().mockReturnValue({ where });
    const select = jest.fn().mockReturnValue({ from });
    const db = {
      query: { invoices: { findMany } },
      select,
    } as unknown as Db;
    const mockCache = { cached: jest.fn().mockImplementation((_k: unknown, fn: () => Promise<unknown>) => fn()) } as any;
    const svc = new InvoicesService(db, mockCache);
    const result = await svc.list(ATTACKER, { page: 1, limit: 20 });
    expect(result.items).toHaveLength(0);
    const call = findMany.mock.calls[0]?.[0];
    expect(sqlValues(call?.where)).toContain(ATTACKER);
  });

  it("returns invoices for the owning org (control — same-tenant)", async () => {
    const findMany = jest.fn().mockResolvedValue([INVOICE_ROW]);
    const where = jest.fn().mockResolvedValue([{ count: 1 }]);
    const from = jest.fn().mockReturnValue({ where });
    const select = jest.fn().mockReturnValue({ from });
    const db = {
      query: { invoices: { findMany } },
      select,
    } as unknown as Db;
    const mockCache = { cached: jest.fn().mockImplementation((_k: unknown, fn: () => Promise<unknown>) => fn()) } as any;
    const svc = new InvoicesService(db, mockCache);
    const result = await svc.list(OWNER, { page: 1, limit: 20 });
    expect(result.items).toHaveLength(1);
  });
});
