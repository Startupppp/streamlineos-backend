import { drizzle } from "drizzle-orm/postgres-js";
import { PgDialect } from "drizzle-orm/pg-core";
import postgres from "postgres";
import * as schema from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import { BuildEntityReadsService } from "./build-entity-reads.service";

const ORG_ID = "org-entity-test";
const USER_ID = "user-entity-test";

function makeDb() {
  return drizzle(
    postgres("postgres://unused:unused@127.0.0.1:1/unused", { max: 1 }),
    { schema },
  );
}

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

function captureWhere(): { db: Db; getWhereArg: () => unknown } {
  let whereArg: unknown;
  const where = jest.fn().mockImplementation((arg: unknown) => {
    whereArg = arg;
    return Promise.resolve([]);
  });
  const from = jest.fn().mockReturnValue({ where });
  const db = { select: jest.fn().mockReturnValue({ from }) } as unknown as Db;
  return { db, getWhereArg: () => whereArg };
}

describe("BuildEntityReadsService.memberProjectIds — full three-branch reachability", () => {
  it("includes the manager branch via manager_membership_id so a user who is the project manager but not a direct member can see project entity cards", () => {
    const { db, getWhereArg } = captureWhere();
    const svc = new BuildEntityReadsService(db);
    void svc.memberProjectIds(ORG_ID, USER_ID, [1, 2, 3]);
    const compiled = dialect.sqlToQuery(getWhereArg() as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(compiled.sql.toLowerCase()).toContain("manager_membership_id");
  });

  it("includes the team branch via project_team_assignments so a user with team-only access can see project entity cards", () => {
    const { db, getWhereArg } = captureWhere();
    const svc = new BuildEntityReadsService(db);
    void svc.memberProjectIds(ORG_ID, USER_ID, [1, 2, 3]);
    const compiled = dialect.sqlToQuery(getWhereArg() as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(compiled.sql.toLowerCase()).toContain("project_team_assignments");
  });

  it("still includes the direct-member branch via project_members so an active direct member continues to see their project entity cards (positive control)", () => {
    const { db, getWhereArg } = captureWhere();
    const svc = new BuildEntityReadsService(db);
    void svc.memberProjectIds(ORG_ID, USER_ID, [1, 2, 3]);
    const compiled = dialect.sqlToQuery(getWhereArg() as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(compiled.sql.toLowerCase()).toContain("project_members");
  });

  it("scopes all branches to the caller's org_id so a cross-tenant user cannot reach foreign project cards", () => {
    const { db, getWhereArg } = captureWhere();
    const svc = new BuildEntityReadsService(db);
    void svc.memberProjectIds(ORG_ID, USER_ID, [1]);
    expect(sqlValues(getWhereArg())).toContain(ORG_ID);
  });

  it("binds user_id as a parameter so membership resolution is scoped to the calling user and cannot be widened by query injection", () => {
    const { db, getWhereArg } = captureWhere();
    const svc = new BuildEntityReadsService(db);
    void svc.memberProjectIds(ORG_ID, USER_ID, [1]);
    expect(sqlValues(getWhereArg())).toContain(USER_ID);
  });
});
