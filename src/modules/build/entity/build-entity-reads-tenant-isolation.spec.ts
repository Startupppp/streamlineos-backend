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
  const MEMBERSHIP_ID = 55;

  function makeDb(membershipResult: { id: number }[], projectRows: unknown[]) {
    let callCount = 0;
    let membershipWhere: unknown;

    const select = jest.fn().mockImplementation(() => {
      callCount++;
      const idx = callCount;

      if (idx === 1) {
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockImplementation((arg: unknown) => {
              membershipWhere = arg;
              return { limit: jest.fn().mockResolvedValue(membershipResult) };
            }),
          }),
        };
      }

      return {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(projectRows),
        }),
      };
    });

    return { db: { select } as unknown as Db, getMembershipWhere: () => membershipWhere };
  }

  it("scopes memberProjectIds membership lookup to the attacker's org — cross-tenant user cannot match a membership in another org", async () => {
    const { db, getMembershipWhere } = makeDb([], []);
    const svc = new BuildEntityReadsService(db);
    const result = await svc.memberProjectIds(ATTACKER_ORG, "u1", [1, 2, 3]);
    expect(result.size).toBe(0);
    expect(sqlValues(getMembershipWhere())).toContain(ATTACKER_ORG);
  });

  it("returns member project IDs for the owning org (same-tenant positive control)", async () => {
    const { db } = makeDb([{ id: MEMBERSHIP_ID }], [{ projectId: 1 }, { projectId: 2 }]);
    const svc = new BuildEntityReadsService(db);
    const result = await svc.memberProjectIds(OWNER_ORG, "u1", [1, 2]);
    expect(result.size).toBe(2);
  });
});
