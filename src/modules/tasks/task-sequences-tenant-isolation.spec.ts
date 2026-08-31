import type { Db } from "../../db/drizzle.module";
import { TaskSequencesService } from "./task-sequences.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((i) => sqlValues(i, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("TaskSequencesService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const ROW = { id: 1, orgId: OWNER, name: "Onboarding", steps: [] };

  it("returns empty for a different org", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const db = { query: { taskSequences: { findMany } } } as unknown as Db;
    const svc = new TaskSequencesService(db);
    const result = await svc.listSequences(ATTACKER, { limit: 20 });
    expect(result).toHaveLength(0);
    const call = findMany.mock.calls[0]?.[0];
    expect(sqlValues(call?.where)).toContain(ATTACKER);
  });

  it("returns sequences for the owning org (control — same-tenant)", async () => {
    const findMany = jest.fn().mockResolvedValue([ROW]);
    const db = { query: { taskSequences: { findMany } } } as unknown as Db;
    const svc = new TaskSequencesService(db);
    const result = await svc.listSequences(OWNER, { limit: 20 });
    expect(result).toHaveLength(1);
  });
});
