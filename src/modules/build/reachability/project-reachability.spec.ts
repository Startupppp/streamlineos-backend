import { drizzle } from "drizzle-orm/postgres-js";
import { PgDialect } from "drizzle-orm/pg-core";
import postgres from "postgres";
import * as schema from "../../../db/schema";
import { reachableProjectsSql } from "./project-reachability";
import { ProjectAccessCache } from "./project-access-cache";

const ORG_ID = "org-reach-test";
const MEMBERSHIP_ID = 7;

function makeDb() {
  return drizzle(
    postgres("postgres://unused:unused@127.0.0.1:1/unused", { max: 1 }),
    { schema },
  );
}

const dialect = new PgDialect();

function renderSql(value: unknown): { sql: string; params: unknown[] } {
  const query = dialect.sqlToQuery(value as Parameters<PgDialect["sqlToQuery"]>[0]);
  return { sql: query.sql, params: query.params };
}

describe("reachableProjectsSql — branch matrix", () => {
  const compiled = renderSql(reachableProjectsSql(ORG_ID, MEMBERSHIP_ID));
  const lower = compiled.sql.toLowerCase();

  it("manager branch: references manager_membership_id so projects where the caller is manager are reachable", () => {
    expect(lower).toContain("manager_membership_id");
  });

  it("direct-member branch: uses a subquery on project_members so direct members are reachable", () => {
    expect(lower).toContain("project_members");
  });

  it("team-member branch: uses a subquery joining project_team_assignments and project_team_members so team members are reachable", () => {
    expect(lower).toContain("project_team_assignments");
    expect(lower).toContain("project_team_members");
  });

  it("binds orgId as a SQL parameter on both subquery branches (not inlined as a literal)", () => {
    const orgBindings = compiled.params.filter((p) => p === ORG_ID).length;
    expect(orgBindings).toBeGreaterThanOrEqual(2);
    expect(compiled.sql).not.toContain(ORG_ID);
  });

  it("binds membershipId as a SQL parameter on all three branches (not inlined as a literal)", () => {
    const midBindings = compiled.params.filter((p) => p === MEMBERSHIP_ID).length;
    expect(midBindings).toBeGreaterThanOrEqual(3);
    expect(compiled.sql).not.toContain(String(MEMBERSHIP_ID));
  });

  it("combines branches with OR so any single branch grants access", () => {
    expect(lower).toContain(" or ");
  });

  it("uses IN (SELECT ...) for direct-member branch so unbounded project-id arrays are never materialized in JS", () => {
    expect(lower).toContain("in (\n      select");
    expect(lower).toContain("project_members");
  });

  it("uses IN (SELECT ...) for team-member branch so unbounded project-id arrays are never materialized in JS", () => {
    expect(lower).toContain("project_team_assignments");
    expect(lower.split("in (").length).toBeGreaterThanOrEqual(3);
  });
});

describe("ProjectAccessCache", () => {
  it("returns the same promise for the same key, so the compute function is called exactly once", async () => {
    const cache = new ProjectAccessCache();
    const compute = jest.fn().mockResolvedValue({ hasAccess: true, role: "MEMBER" });
    const [r1, r2] = await Promise.all([
      cache.get(ORG_ID, "u1", 1, compute),
      cache.get(ORG_ID, "u1", 1, compute),
    ]);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(r1).toEqual(r2);
  });

  it("returns distinct promises for different projectIds, so per-project access is not blurred", async () => {
    const cache = new ProjectAccessCache();
    const compute1 = jest.fn().mockResolvedValue({ hasAccess: true, role: "MEMBER" });
    const compute2 = jest.fn().mockResolvedValue({ hasAccess: false, role: null });
    const [r1, r2] = await Promise.all([
      cache.get(ORG_ID, "u1", 1, compute1),
      cache.get(ORG_ID, "u1", 2, compute2),
    ]);
    expect(r1.hasAccess).toBe(true);
    expect(r2.hasAccess).toBe(false);
    expect(compute1).toHaveBeenCalledTimes(1);
    expect(compute2).toHaveBeenCalledTimes(1);
  });

  it("returns distinct promises for different users, so cross-user bleed cannot occur", async () => {
    const cache = new ProjectAccessCache();
    const computeA = jest.fn().mockResolvedValue({ hasAccess: true, role: "OWNER" });
    const computeB = jest.fn().mockResolvedValue({ hasAccess: false, role: null });
    const [rA, rB] = await Promise.all([
      cache.get(ORG_ID, "u-alice", 5, computeA),
      cache.get(ORG_ID, "u-bob", 5, computeB),
    ]);
    expect(rA.hasAccess).toBe(true);
    expect(rB.hasAccess).toBe(false);
  });

  it("evicts a failed entry so the next call re-computes rather than replaying the error", async () => {
    const cache = new ProjectAccessCache();
    const err = new Error("transient");
    const compute = jest.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ hasAccess: true, role: "MEMBER" });
    await expect(cache.get(ORG_ID, "u1", 1, compute)).rejects.toThrow("transient");
    const result = await cache.get(ORG_ID, "u1", 1, compute);
    expect(result.hasAccess).toBe(true);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("invalidate(projectId) evicts only the matching project entry, leaving others intact", async () => {
    const cache = new ProjectAccessCache();
    const compute1 = jest.fn().mockResolvedValue({ hasAccess: true, role: "MEMBER" });
    const compute2 = jest.fn().mockResolvedValue({ hasAccess: true, role: "OWNER" });
    await cache.get(ORG_ID, "u1", 10, compute1);
    await cache.get(ORG_ID, "u1", 20, compute2);
    cache.invalidate(10);
    const recompute1 = jest.fn().mockResolvedValue({ hasAccess: false, role: null });
    await cache.get(ORG_ID, "u1", 10, recompute1);
    expect(recompute1).toHaveBeenCalledTimes(1);
    const recompute2 = jest.fn();
    await cache.get(ORG_ID, "u1", 20, recompute2);
    expect(recompute2).not.toHaveBeenCalled();
  });

  it("invalidate() with no argument clears all entries", async () => {
    const cache = new ProjectAccessCache();
    const compute = jest.fn().mockResolvedValue({ hasAccess: true, role: null });
    await cache.get(ORG_ID, "u1", 1, compute);
    await cache.get(ORG_ID, "u1", 2, compute);
    cache.invalidate();
    const recompute = jest.fn().mockResolvedValue({ hasAccess: false, role: null });
    await cache.get(ORG_ID, "u1", 1, recompute);
    await cache.get(ORG_ID, "u1", 2, recompute);
    expect(recompute).toHaveBeenCalledTimes(2);
  });

  it("cache is request-local: a second cache instance does not share state with the first", async () => {
    const cache1 = new ProjectAccessCache();
    const cache2 = new ProjectAccessCache();
    const compute1 = jest.fn().mockResolvedValue({ hasAccess: true, role: "MEMBER" });
    const compute2 = jest.fn().mockResolvedValue({ hasAccess: false, role: null });
    await cache1.get(ORG_ID, "u1", 1, compute1);
    await cache2.get(ORG_ID, "u1", 1, compute2);
    expect(compute1).toHaveBeenCalledTimes(1);
    expect(compute2).toHaveBeenCalledTimes(1);
  });
});
