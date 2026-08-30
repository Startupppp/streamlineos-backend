import type { Db } from "../../../db/drizzle.module";
import { BuildEntityReadsService } from "./build-entity-reads.service";

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

describe("BuildEntityReadsService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  function makeDb(memberRows: unknown[]) {
    const where = jest.fn().mockResolvedValue(memberRows);
    const from = jest.fn().mockReturnValue({ where });
    const select = jest.fn().mockReturnValue({ from });
    return { db: { select } as unknown as Db, where };
  }

  it("scopes memberProjectIds to the attacker's org — returns empty set (cross-tenant isolation)", async () => {
    const { db, where } = makeDb([]);
    const svc = new BuildEntityReadsService(db);
    const result = await svc.memberProjectIds(ATTACKER_ORG, "u1", [1, 2, 3]);
    expect(result.size).toBe(0);
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
  });

  it("returns member project IDs for the owning org (same-tenant control)", async () => {
    const { db } = makeDb([{ projectId: 1 }, { projectId: 2 }]);
    const svc = new BuildEntityReadsService(db);
    const result = await svc.memberProjectIds(OWNER_ORG, "u1", [1, 2]);
    expect(result.size).toBe(2);
  });
});
