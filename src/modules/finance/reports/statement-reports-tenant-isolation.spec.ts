import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { StatementReportsService } from "./statement-reports.service";

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

type ChainResult = Promise<unknown[]> & { limit: jest.Mock; orderBy: jest.Mock; groupBy: jest.Mock; offset: jest.Mock };

function makeChainResult(rows: unknown[] = []): ChainResult {
  const p = Promise.resolve(rows) as ChainResult;
  p.limit = jest.fn().mockResolvedValue(rows);
  p.orderBy = jest.fn().mockResolvedValue(rows);
  p.groupBy = jest.fn().mockResolvedValue(rows);
  p.offset = jest.fn().mockResolvedValue(rows);
  return p;
}

describe("StatementReportsService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";

  it("throws NotFoundException when vendor belongs to a different org (BOLA isolation)", async () => {
    const db = {
      select: jest.fn().mockImplementation(() => ({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue(makeChainResult([])),
          leftJoin: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue(makeChainResult([])) }),
        }),
      })),
    } as unknown as Db;
    const cache = { cachedVersioned: jest.fn().mockImplementation((_n: unknown, _k: unknown, fn: () => unknown) => fn()) } as never;
    const svc = new StatementReportsService(db, cache);

    await expect(svc.vendorStatement(ATTACKER_ORG, 999, "2024-01-01", "2024-12-31")).rejects.toThrow(NotFoundException);
  });

  it("does not throw for a vendor owned by the same org (same-tenant control)", async () => {
    const vendor = { id: 1, name: "Vendor A" };
    let callCount = 0;
    const db = {
      select: jest.fn().mockImplementation(() => {
        callCount++;
        const rows = callCount === 1 ? [vendor] : [];
        return { from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue(makeChainResult(rows)) }) };
      }),
    } as unknown as Db;
    const cache = { cachedVersioned: jest.fn().mockImplementation((_n: unknown, _k: unknown, fn: () => unknown) => fn()) } as never;
    const svc = new StatementReportsService(db, cache);

    const err = await svc.vendorStatement(OWNER_ORG, 1, "2024-01-01", "2024-12-31").catch(e => e);

    expect(err).not.toBeInstanceOf(NotFoundException);
  });
});
