import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../../db/drizzle.module";
import { OrgStructureService } from "../org-structure.service";
import type { CacheService } from "../../../../common/cache/cache.service";
import type { EmploymentFactsService } from "../../../directory/employment-facts.service";
import { ScopedRead } from "../../../access/scoped-read";

function makeSelectChain(rows: unknown[]) {
  const where = jest.fn();
  const chain: Record<string, unknown> = {
    from: jest.fn(),
    where,
    limit: jest.fn(),
    orderBy: jest.fn(),
    leftJoin: jest.fn(),
    innerJoin: jest.fn(),
  };
  for (const k of ["from", "where", "limit", "orderBy", "leftJoin", "innerJoin"])
    (chain[k] as jest.Mock).mockReturnValue(chain);
  where.mockReturnValue({ limit: jest.fn().mockResolvedValue(rows) });
  return chain;
}

function makeService(deptRows: unknown[], membershipRows: unknown[]) {
  let callIndex = 0;
  const results = [deptRows, membershipRows];
  const select = jest.fn().mockImplementation(() => {
    const rows = results[callIndex++ % results.length] ?? [];
    return makeSelectChain(rows);
  });
  const db = { select } as unknown as Db;
  const cache = { cached: jest.fn() } as unknown as CacheService;
  const employment = { getFactsBatch: jest.fn().mockResolvedValue(new Map()) } as unknown as EmploymentFactsService;
  return new OrgStructureService(db, cache, employment, undefined as never);
}

describe("OrgStructureService.getTeam — soft-delete predicate", () => {
  const ORG = "org-1";
  const ACTOR = "user-a";
  const TEAM_ID = "dept-1";

  it("throws NotFoundException when the team is soft-deleted (DB returns no row)", async () => {
    const svc = makeService([], []);
    await expect(svc.getTeam(ScopedRead.of(ORG, ACTOR, "all"), TEAM_ID)).rejects.toThrow(NotFoundException);
  });

  it("returns team data when the team is live (DB returns a row)", async () => {
    const DEPT_ROW = { id: TEAM_ID, name: "Engineering", headUserId: null };
    const svc = makeService([DEPT_ROW], []);
    const result = await svc.getTeam(ScopedRead.of(ORG, ACTOR, "all"), TEAM_ID);
    expect(result.id).toBe(TEAM_ID);
    expect(result.name).toBe("Engineering");
  });
});
