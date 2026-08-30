import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { TeamsService } from "./teams.service";

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

describe("TeamsService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  const audit = { log: jest.fn() } as never;
  const pmWorkspaces = { resolveDefaultWorkspaceId: jest.fn().mockResolvedValue(1) } as never;

  function makeSelectDb(firstCallRows: unknown[], subsequentRows: unknown[] = []) {
    const limit = jest.fn()
      .mockResolvedValueOnce(firstCallRows)
      .mockResolvedValue(subsequentRows);
    const where = jest.fn().mockReturnValue({ limit });
    const from = jest.fn().mockReturnValue({ where, innerJoin: jest.fn().mockReturnValue({ where }) });
    const select = jest.fn().mockReturnValue({ from });
    return { db: { select } as unknown as Db, where };
  }

  it("throws NotFoundException for getTeam on a different org (cross-tenant isolation)", async () => {
    const { db } = makeSelectDb([]);
    const svc = new TeamsService(db, audit, pmWorkspaces);
    await expect(svc.getTeam(ATTACKER_ORG, 99)).rejects.toThrow(NotFoundException);
  });

  it("returns team for the owning org (same-tenant control)", async () => {
    const team = { id: 10, orgId: OWNER_ORG, name: "Eng" };
    const { db } = makeSelectDb([team], []);
    const svc = new TeamsService(db, audit, pmWorkspaces);
    const result = await svc.getTeam(OWNER_ORG, 10);
    expect(result).toMatchObject({ id: 10 });
  });
});
