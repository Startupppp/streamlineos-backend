import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "../../../db/drizzle.module";
import { BuildEntityReadsService } from "./build-entity-reads.service";

const ORG_ID = "org-entity-test";
const USER_ID = "user-entity-test";
const MEMBERSHIP_ID = 77;

const dialect = new PgDialect();

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

function makeTwoCallDb(
  membershipResult: { id: number }[] = [{ id: MEMBERSHIP_ID }],
): { db: Db; getReachabilityWhereArg: () => unknown; getMembershipWhereArg: () => unknown } {
  let membershipWhereArg: unknown;
  let reachabilityWhereArg: unknown;
  let callCount = 0;

  const db = {
    select: jest.fn().mockImplementation(() => {
      callCount++;
      const idx = callCount;

      if (idx === 1) {
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockImplementation((arg: unknown) => {
              membershipWhereArg = arg;
              return { limit: jest.fn().mockResolvedValue(membershipResult) };
            }),
          }),
        };
      }

      return {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation((arg: unknown) => {
            reachabilityWhereArg = arg;
            return Promise.resolve([]);
          }),
        }),
      };
    }),
  } as unknown as Db;

  return {
    db,
    getReachabilityWhereArg: () => reachabilityWhereArg,
    getMembershipWhereArg: () => membershipWhereArg,
  };
}

describe("BuildEntityReadsService.memberProjectIds — delegates to canonical reachability predicate", () => {
  it("includes the manager branch (manager_membership_id) so a project manager with no direct membership can see project entity cards", async () => {
    const { db, getReachabilityWhereArg } = makeTwoCallDb();
    const svc = new BuildEntityReadsService(db);
    await svc.memberProjectIds(ORG_ID, USER_ID, [1, 2, 3]);
    const compiled = dialect.sqlToQuery(getReachabilityWhereArg() as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(compiled.sql.toLowerCase()).toContain("manager_membership_id");
  });

  it("includes the team branch (project_team_assignments) so a user with team-only membership can see project entity cards", async () => {
    const { db, getReachabilityWhereArg } = makeTwoCallDb();
    const svc = new BuildEntityReadsService(db);
    await svc.memberProjectIds(ORG_ID, USER_ID, [1, 2, 3]);
    const compiled = dialect.sqlToQuery(getReachabilityWhereArg() as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(compiled.sql.toLowerCase()).toContain("project_team_assignments");
  });

  it("includes the direct-member branch (project_members) so an active direct member continues to see project entity cards", async () => {
    const { db, getReachabilityWhereArg } = makeTwoCallDb();
    const svc = new BuildEntityReadsService(db);
    await svc.memberProjectIds(ORG_ID, USER_ID, [1, 2, 3]);
    const compiled = dialect.sqlToQuery(getReachabilityWhereArg() as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(compiled.sql.toLowerCase()).toContain("project_members");
  });

  it("includes the ACTIVE status check on organization_members so a suspended membership cannot grant project entity card access", async () => {
    const { db, getReachabilityWhereArg } = makeTwoCallDb();
    const svc = new BuildEntityReadsService(db);
    await svc.memberProjectIds(ORG_ID, USER_ID, [1, 2, 3]);
    const compiled = dialect.sqlToQuery(getReachabilityWhereArg() as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(compiled.sql.toLowerCase()).toContain("organization_members");
    expect(compiled.params).toContain("ACTIVE");
  });

  it("returns an empty set when the caller has no active membership in the org so a non-member cannot see any project entity cards (negative: reachability denied)", async () => {
    const { db } = makeTwoCallDb([]);
    const svc = new BuildEntityReadsService(db);
    const result = await svc.memberProjectIds(ORG_ID, USER_ID, [1, 2, 3]);
    expect(result.size).toBe(0);
  });

  it("skips the reachability query when the caller has no active membership so no unnecessary DB call is made", async () => {
    const { db } = makeTwoCallDb([]);
    const svc = new BuildEntityReadsService(db);
    await svc.memberProjectIds(ORG_ID, USER_ID, [1, 2, 3]);
    expect((db.select as jest.Mock).mock.calls).toHaveLength(1);
  });

  it("scopes the membership lookup to the caller's org_id so a user in a different org cannot be matched", async () => {
    const { db, getMembershipWhereArg } = makeTwoCallDb();
    const svc = new BuildEntityReadsService(db);
    await svc.memberProjectIds(ORG_ID, USER_ID, [1]);
    expect(sqlValues(getMembershipWhereArg())).toContain(ORG_ID);
  });

  it("scopes the membership lookup to the caller's user_id so one user cannot reach another user's project entity cards", async () => {
    const { db, getMembershipWhereArg } = makeTwoCallDb();
    const svc = new BuildEntityReadsService(db);
    await svc.memberProjectIds(ORG_ID, USER_ID, [1]);
    expect(sqlValues(getMembershipWhereArg())).toContain(USER_ID);
  });
});
