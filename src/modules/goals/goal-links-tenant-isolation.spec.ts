import { NotFoundException } from "@nestjs/common";
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

function makeChainableDb(rows: unknown[]): { db: Db; where: jest.Mock; goalFindFirst: jest.Mock } {
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
  const goalFindFirst = jest.fn().mockResolvedValue({ id: 10 });
  const db = {
    query: { okrGoals: { findFirst: goalFindFirst } },
    select: jest.fn().mockReturnValue(builder),
  } as unknown as Db;
  return { db, where, goalFindFirst };
}

describe("GoalLinksService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const GOAL_ID = 10;

  it("refuses a different org's goal instead of returning an empty link list", async () => {
    const { db, where, goalFindFirst } = makeChainableDb([]);
    goalFindFirst.mockResolvedValue(undefined);
    const svc = new GoalLinksService(db);

    await expect(svc.getLinks(ATTACKER, GOAL_ID)).rejects.toThrow(NotFoundException);

    expect(where).not.toHaveBeenCalled();
    expect(sqlValues(goalFindFirst.mock.calls[0]?.[0]?.where)).toContain(ATTACKER);
  });

  it("returns links for the owning org (control — same-tenant)", async () => {
    const ROW = { id: 1, goalId: GOAL_ID, orgId: OWNER, ticketId: null, projectId: 5, createdAt: new Date(), ticketTitle: null, ticketProjectId: null, projectName: "P", projectKey: "P-1" };
    const { db } = makeChainableDb([ROW]);
    const svc = new GoalLinksService(db);
    const result = await svc.getLinks(OWNER, GOAL_ID);
    expect(result).toHaveLength(1);
  });
});
