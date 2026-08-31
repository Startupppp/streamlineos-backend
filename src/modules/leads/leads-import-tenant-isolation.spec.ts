import type { Db } from "../../db/drizzle.module";
import { LeadsImportService } from "./leads-import.service";

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
  builder.leftJoin = jest.fn().mockImplementation(chain);
  builder.innerJoin = jest.fn().mockImplementation(chain);
  builder.orderBy = jest.fn().mockImplementation(chain);
  builder.limit = jest.fn().mockImplementation(chain);
  where.mockImplementation(chain);
  const db = { select: jest.fn().mockReturnValue(builder) } as unknown as Db;
  return { db, where };
}

describe("LeadsImportService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  function makeService(rows: unknown[]) {
    const { db, where } = makeThenableBuilder(rows);
    const crmValidation = { getFieldDefinitions: jest.fn().mockResolvedValue([]), evaluate: jest.fn().mockResolvedValue({ valid: true, errors: [] }) };
    const planLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };
    const access = { getDataScope: jest.fn() };
    const svc = new LeadsImportService(db, crmValidation as never, planLimits as never, access as never);
    return { svc, where };
  }

  it("scopes dedup query to the importing org (cross-tenant isolation)", async () => {
    const { svc, where } = makeService([]);
    await svc.importLeads(ATTACKER, "user-1", { leads: [{ name: "Test", email: "t@test.com", phone: undefined }], duplicateAction: "skip", autoDistribute: false });
    const allVals = where.mock.calls.flat().flatMap((c: unknown) => sqlValues(c));
    expect(allVals).toContain(ATTACKER);
  });

  it("uses the correct org for dedup lookup (control)", async () => {
    const { svc, where } = makeService([]);
    await svc.importLeads(OWNER, "user-1", { leads: [{ name: "Test", email: "o@owner.com", phone: undefined }], duplicateAction: "skip", autoDistribute: false });
    const allVals = where.mock.calls.flat().flatMap((c: unknown) => sqlValues(c));
    expect(allVals).toContain(OWNER);
  });
});
