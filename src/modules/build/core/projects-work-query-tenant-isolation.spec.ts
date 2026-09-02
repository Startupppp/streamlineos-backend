import type { Db } from "../../../db/drizzle.module";
import { ProjectsWorkQueryService } from "./projects-work-query.service";

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

describe("ProjectsWorkQueryService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  function makeDb(memberRows: unknown[], ticketRows: unknown[]) {
    const ticketOrderBy = jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(ticketRows) });
    const ticketInnerJoin = jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ orderBy: ticketOrderBy }) });
    const memberWhere = jest.fn().mockResolvedValue(memberRows);
    const memberInnerJoin = jest.fn().mockReturnValue({ where: memberWhere });
    const select = jest.fn()
      .mockReturnValueOnce({ from: jest.fn().mockReturnValue({ innerJoin: memberInnerJoin }) })
      .mockReturnValue({ from: jest.fn().mockReturnValue({ innerJoin: ticketInnerJoin }) });
    return { db: { select } as unknown as Db, memberWhere, memberInnerJoin };
  }

  it("scopes search to attacker's orgId — returns empty when org has no projects (cross-tenant isolation)", async () => {
    const { db, memberWhere, memberInnerJoin } = makeDb([], []);
    const svc = new ProjectsWorkQueryService(db);
    const result = await svc.searchOrgTickets(ATTACKER_ORG, "u1", "query", 10);
    expect(result).toHaveLength(0);
    expect(sqlValues(memberWhere.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
    expect(sqlValues(memberInnerJoin.mock.calls[0]?.[1])).toContain("u1");
  });

  it("returns tickets for the owning org when member of project (same-tenant control)", async () => {
    const ROW = { id: 1, title: "T", status: "open", priority: "high", ticketNumber: 1, projectId: 10, projectKey: "P", projectName: "Proj" };
    const memberWhere = jest.fn().mockResolvedValue([{ projectId: 10 }]);
    const limit = jest.fn().mockResolvedValue([ROW]);
    const orderBy = jest.fn().mockReturnValue({ limit });
    const innerJoin = jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ orderBy }) });
    const select = jest.fn()
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({ where: memberWhere }),
        }),
      })
      .mockReturnValue({ from: jest.fn().mockReturnValue({ innerJoin }) });
    const db = { select } as unknown as Db;
    const svc = new ProjectsWorkQueryService(db);
    const result = await svc.searchOrgTickets(OWNER_ORG, "u1", "T", 10);
    expect(result).toHaveLength(1);
  });
});
