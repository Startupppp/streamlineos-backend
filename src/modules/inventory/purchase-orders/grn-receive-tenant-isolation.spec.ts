import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { GrnReceiveService } from "./grn-receive.service";

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

describe("GrnReceiveService — cross-tenant isolation", () => {
  it("receiveGoods: throws NotFoundException for a PO in a different org (deny)", async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const db = { query: { invPurchaseOrders: { findFirst } } } as unknown as Db;
    const cache = {} as never;
    const engine = {} as never;
    const settingsService = {} as never;
    const numSeq = {} as never;
    const posting = {} as never;
    const poService = {} as never;
    const svc = new GrnReceiveService(db, cache, engine, settingsService, numSeq, posting, poService);
    await expect(
      svc.receiveGoods(ATTACKER, 1, "user-1", "idem-key", { lines: [], notes: undefined, receivedDate: "2025-01-01", locationId: undefined }),
    ).rejects.toThrow(NotFoundException);
    expect(findFirst).toHaveBeenCalled();
    const whereArg = findFirst.mock.calls[0]?.[0]?.where;
    const vals = sqlValues(whereArg);
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("receiveGoods: reaches post-tenant-check logic when PO belongs to the correct org (control)", async () => {
    const po = {
      id: 1,
      orgId: OWNER,
      status: "SENT",
      poNumber: "PO-001",
      warehouseId: 5,
      lines: [],
    };
    const findFirst = jest.fn().mockResolvedValue(po);
    const db = { query: { invPurchaseOrders: { findFirst } } } as unknown as Db;
    const settingsService = { get: jest.fn().mockResolvedValue({ overReceiptTolerancePct: "0", inspectionOnReceipt: false }) } as never;
    const numSeq = { next: jest.fn().mockResolvedValue("GRN-001") } as never;
    const cache = { del: jest.fn().mockResolvedValue(undefined), invalidateNamespace: jest.fn().mockResolvedValue(undefined) } as never;
    const engine = { executeInTx: jest.fn().mockResolvedValue(undefined), invalidateCaches: jest.fn().mockResolvedValue(undefined) } as never;
    const posting = { submit: jest.fn().mockResolvedValue({ journalId: "j-1", journalNumber: "JV-1", replayed: false }) } as never;
    const poService = { resolveLocationId: jest.fn().mockResolvedValue(1) } as never;

    const grnRow = { id: 10, orgId: OWNER };
    const tx = {
      execute: jest.fn(),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([grnRow]) }),
      }),
      update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }),
      query: {
        invLocations: { findFirst: jest.fn().mockResolvedValue(null) },
        invPoLines: { findMany: jest.fn().mockResolvedValue([]) },
        invGrns: { findFirst: jest.fn().mockResolvedValue(grnRow) },
      },
    };
    const grnFindFirst = jest.fn().mockResolvedValue(grnRow);
    const dbWithTx = {
      query: {
        invPurchaseOrders: { findFirst },
        invLocations: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) },
        invGrns: { findFirst: grnFindFirst },
      },
      transaction: jest.fn().mockImplementation((cb: (tx: unknown) => unknown) => cb(tx)),
    } as unknown as Db;

    const svc = new GrnReceiveService(dbWithTx, cache, engine, settingsService, numSeq, posting, poService);
    const result = await svc.receiveGoods(OWNER, 1, "user-1", "idem-key", { lines: [], notes: undefined, receivedDate: "2025-01-01", locationId: undefined });
    const whereArg = findFirst.mock.calls[0]?.[0]?.where;
    const vals = sqlValues(whereArg);
    expect(vals).toContain(OWNER);
    expect(result).toBeDefined();
  });
});
