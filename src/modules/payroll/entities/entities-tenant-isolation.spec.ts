import type { Db } from "../../../db/drizzle.module";
import { PayrollEntitiesService } from "./entities.service";

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

describe("PayrollEntitiesService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  function makeDb(rows: unknown[]) {
    const limit = jest.fn().mockResolvedValue(rows);
    const orderBy = jest.fn().mockReturnValue({ limit });
    const where = jest.fn().mockReturnValue({ orderBy });
    const from = jest.fn().mockReturnValue({ where });
    const select = jest.fn().mockReturnValue({ from });
    return { db: { select } as unknown as Db, where };
  }

  it("returns only attacker-org entities (empty) — orgId scoped (cross-tenant isolation)", async () => {
    const { db, where } = makeDb([]);
    const svc = new PayrollEntitiesService(db);
    const result = await svc.list(ATTACKER_ORG);
    expect(result).toHaveLength(0);
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
  });

  it("returns entities for the owning org (same-tenant control)", async () => {
    const entity = { id: 1, orgId: OWNER_ORG, legalName: "Org Ltd" };
    const { db } = makeDb([entity]);
    const svc = new PayrollEntitiesService(db);
    const result = await svc.list(OWNER_ORG);
    expect(result).toHaveLength(1);
  });
});
