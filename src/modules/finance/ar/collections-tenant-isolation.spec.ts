import type { Db } from "../../../db/drizzle.module";
import { CollectionsService } from "./collections.service";

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

describe("CollectionsService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";

  it("scopes invoice query to the requesting org in summary (tenant isolation)", async () => {
    const where = jest.fn().mockResolvedValue([]);
    const db = {
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where }) }),
    } as unknown as Db;
    const svc = new CollectionsService(db, {} as never);

    await svc.summary(ATTACKER_ORG);

    expect(where).toHaveBeenCalled();
    const vals = sqlValues(where.mock.calls[0]?.[0]);
    expect(vals).toContain(ATTACKER_ORG);
  });

  it("returns summary data for the owning org (same-tenant control)", async () => {
    const row = { id: 1, clientId: 10, total: "1000.00", amountPaid: "0.00", dueDate: "2026-01-01", status: "ISSUED" };
    const where = jest.fn().mockResolvedValue([row]);
    const db = {
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where }) }),
    } as unknown as Db;
    const svc = new CollectionsService(db, {} as never);

    const result = await svc.summary(OWNER_ORG);

    expect(result.agingBuckets).toBeDefined();
  });
});
