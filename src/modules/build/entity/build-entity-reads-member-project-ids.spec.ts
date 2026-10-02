import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import type { DataScope } from "../../access/access.types";
import type { EntityActor } from "../../entity-reference/entity-reference.types";
import { BuildEntityReadsService } from "./build-entity-reads.service";

const ORG_ID = "org-entity-test";
const USER_ID = "user-entity-test";
const MEMBERSHIP_ID = 4242;

const dialect = new PgDialect();

const ACTOR: EntityActor = { orgId: ORG_ID, userId: USER_ID, membershipId: MEMBERSHIP_ID, isOrgOwner: false };
const VIEWER = new Map<string, DataScope>([["build:view", "own"]]);

async function projectCardWhere(): Promise<{ sql: string; params: unknown[] }> {
  let whereArg: SQL | undefined;
  const limit = jest.fn().mockResolvedValue([]);
  const where = jest.fn((arg: SQL) => {
    whereArg = arg;
    return { limit };
  });
  const from = jest.fn().mockReturnValue({ where });
  const db = { select: jest.fn().mockReturnValue({ from }) } as unknown as Db;
  await new BuildEntityReadsService(db).resolveWith(
    ACTOR,
    [{ type: "project", id: "1" }],
    VIEWER,
  );
  if (!whereArg) throw new Error("project card read issued no predicate");
  const compiled = dialect.sqlToQuery(whereArg);
  return { sql: compiled.sql.toLowerCase(), params: compiled.params };
}

describe("BuildEntityReadsService project cards — full three-branch reachability from the project-access rule", () => {
  it("includes the manager branch via manager_membership_id so a user who is the project manager but not a direct member can see project entity cards", async () => {
    expect((await projectCardWhere()).sql).toContain("manager_membership_id");
  });

  it("includes the team branch via project_team_assignments so a user with team-only access can see project entity cards", async () => {
    expect((await projectCardWhere()).sql).toContain("project_team_assignments");
  });

  it("still includes the direct-member branch via project_members so an active direct member continues to see their project entity cards (positive control)", async () => {
    expect((await projectCardWhere()).sql).toContain("project_members");
  });

  it("scopes all branches to the caller's org_id so a cross-tenant user cannot reach foreign project cards", async () => {
    expect((await projectCardWhere()).params).toContain(ORG_ID);
  });

  it("binds the caller's membership id as a parameter so reachability is scoped to the calling member and cannot be widened by query injection", async () => {
    const { sql, params } = await projectCardWhere();
    expect(params).toContain(MEMBERSHIP_ID);
    expect(sql).not.toContain(String(MEMBERSHIP_ID));
  });
});
