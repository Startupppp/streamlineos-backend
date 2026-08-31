import type { Db } from "../../db/drizzle.module";
import { DealsImportExportService } from "./deals-import-export.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((i) => sqlValues(i, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

function makeThenableBuilder(rows: unknown[]) {
  const where = jest.fn();
  const builder: Record<string, unknown> = {
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject),
  };
  const chain = () => builder;
  builder.from = jest.fn().mockImplementation(chain);
  builder.where = where;
  builder.innerJoin = jest.fn().mockImplementation(chain);
  builder.leftJoin = jest.fn().mockImplementation(chain);
  builder.orderBy = jest.fn().mockImplementation(chain);
  builder.limit = jest.fn().mockImplementation(chain);
  where.mockImplementation(chain);
  const db = { select: jest.fn().mockReturnValue(builder) } as unknown as Db;
  return { db, where };
}

describe("DealsImportExportService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  it("scopes member lookup to the importing org (cross-tenant isolation)", async () => {
    const { db, where } = makeThenableBuilder([]);
    const planLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };
    const crud = { create: jest.fn().mockResolvedValue({ id: 1 }) };
    const svc = new DealsImportExportService(db, planLimits as never, crud as never);
    await svc.bulkImport(ATTACKER, "user-1", { deals: [{ name: "Deal A", stage: "NEW", value: 100, ownerEmail: "a@test.com" }] });
    const allVals = where.mock.calls.flat().flatMap((c: unknown) => sqlValues(c));
    expect(allVals).toContain(ATTACKER);
  });

  it("uses the correct org for member lookup (control)", async () => {
    const { db, where } = makeThenableBuilder([{ userId: "u1", email: "o@owner.com" }]);
    const planLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };
    const crud = { create: jest.fn().mockResolvedValue({ id: 1 }) };
    const svc = new DealsImportExportService(db, planLimits as never, crud as never);
    await svc.bulkImport(OWNER, "user-1", { deals: [{ name: "Deal B", stage: "NEW", value: 200, ownerEmail: "o@owner.com" }] });
    const allVals = where.mock.calls.flat().flatMap((c: unknown) => sqlValues(c));
    expect(allVals).toContain(OWNER);
  });
});
