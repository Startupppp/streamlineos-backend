import type { Db } from "../../../db/drizzle.module";
import { BillsDueCheckService } from "./bills-due-check.service";

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

describe("BillsDueCheckService — cross-tenant isolation", () => {
  const TARGET_ORG = "org-target";

  it("scopes the sweep to a specific org when orgId is provided (tenant isolation)", async () => {
    const where = jest.fn().mockResolvedValue([]);
    const from = jest.fn().mockReturnValue({ leftJoin: jest.fn().mockReturnValue({ where }) });
    const db = { select: jest.fn().mockReturnValue({ from }) } as unknown as Db;
    const cache = { cached: jest.fn().mockResolvedValue("SENT") } as never;
    const dispatch = { emit: jest.fn() } as any;
    const svc = new BillsDueCheckService(db, cache, dispatch);

    await svc.checkBillsDue(TARGET_ORG);

    expect(where).toHaveBeenCalledTimes(1);
    const vals = sqlValues(where.mock.calls[0]?.[0]);
    expect(vals).toContain(TARGET_ORG);
  });

  it("returns without dispatching when no bills are due (same-org control)", async () => {
    const where = jest.fn().mockResolvedValue([]);
    const from = jest.fn().mockReturnValue({ leftJoin: jest.fn().mockReturnValue({ where }) });
    const db = { select: jest.fn().mockReturnValue({ from }) } as unknown as Db;
    const cache = { cached: jest.fn() } as never;
    const emitMock = jest.fn();
    const dispatch = { emit: emitMock } as never;
    const svc = new BillsDueCheckService(db, cache, dispatch);

    await svc.checkBillsDue(TARGET_ORG);

    expect(emitMock).not.toHaveBeenCalled();
  });
});
