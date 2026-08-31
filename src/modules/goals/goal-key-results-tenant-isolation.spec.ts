import type { Db } from "../../db/drizzle.module";
import { GoalKeyResultsService } from "./goal-key-results.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((i) => sqlValues(i, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("GoalKeyResultsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const GOAL_ID = 42;
  const ROW = { id: 1, orgId: OWNER, goalId: GOAL_ID, title: "KR1" };

  it("returns empty for a different org's key results", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const db = { query: { okrKeyResults: { findMany } } } as unknown as Db;
    const svc = new GoalKeyResultsService(db);
    const result = await svc.listKeyResults(ATTACKER, GOAL_ID);
    expect(result).toHaveLength(0);
    const call = findMany.mock.calls[0]?.[0];
    expect(sqlValues(call?.where)).toContain(ATTACKER);
  });

  it("returns key results for the owning org (control — same-tenant)", async () => {
    const findMany = jest.fn().mockResolvedValue([ROW]);
    const db = { query: { okrKeyResults: { findMany } } } as unknown as Db;
    const svc = new GoalKeyResultsService(db);
    const result = await svc.listKeyResults(OWNER, GOAL_ID);
    expect(result).toHaveLength(1);
  });
});
