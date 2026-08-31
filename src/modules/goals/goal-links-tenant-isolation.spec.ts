import type { Db } from "../../db/drizzle.module";
import { GoalLinksService } from "./goal-links.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((i) => sqlValues(i, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

function makeChainableDb(rows: unknown[]): { db: Db; where: jest.Mock } {
  const where = jest.fn().mockResolvedValue(rows);
  const builder = {
    from: jest.fn(),
    where,
    leftJoin: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
  };
  builder.from.mockReturnValue(builder);
  builder.leftJoin.mockReturnValue(builder);
  builder.orderBy.mockReturnValue(builder);
  builder.where.mockReturnValue(builder);
  const db = { select: jest.fn().mockReturnValue(builder) } as unknown as Db;
  return { db, where };
}

describe("GoalLinksService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const GOAL_ID = 10;

  it("returns no links for a different org's goal", async () => {
    const { db, where } = makeChainableDb([]);
    const svc = new GoalLinksService(db);
    const result = await svc.getLinks(ATTACKER, GOAL_ID);
    expect(result).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("returns links for the owning org (control — same-tenant)", async () => {
    const ROW = { id: 1, goalId: GOAL_ID, orgId: OWNER, ticketId: null, projectId: 5, createdAt: new Date(), ticketTitle: null, ticketProjectId: null, projectName: "P", projectKey: "P-1" };
    const { db } = makeChainableDb([ROW]);
    const svc = new GoalLinksService(db);
    const result = await svc.getLinks(OWNER, GOAL_ID);
    expect(result).toHaveLength(1);
  });
});
