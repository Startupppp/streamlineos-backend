import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import type { DataScope } from "../../access/access.types";
import type { EntityActor } from "../../entity-reference/entity-reference.types";
import { BuildEntityReadsService } from "./build-entity-reads.service";
import { entityProjectReach, entityProjectWriteRefusal } from "./build-entity-action-helpers";

const dialect = new PgDialect();
const MEMBER: EntityActor = { orgId: "org-1", userId: "user-1", membershipId: 7, isOrgOwner: false };
const OWNER: EntityActor = { ...MEMBER, isOrgOwner: true };

const grants = (entries: ReadonlyArray<[string, DataScope]>) => new Map<string, DataScope>(entries);

function capturingDb(rows: object[]) {
  const captured: SQL[] = [];
  const limit = jest.fn(async () => rows);
  const chain = {
    innerJoin: jest.fn((): object => chain),
    where: jest.fn((predicate: SQL) => {
      captured.push(predicate);
      return { limit };
    }),
  };
  const select = jest.fn(() => ({ from: jest.fn(() => chain) }));
  return { db: { select } as unknown as Db, captured };
}

const sqlOf = (predicate: SQL | undefined) => {
  if (!predicate) throw new Error("expected a card query predicate");
  return dialect.sqlToQuery(predicate).sql;
};

describe("entity cards and actions use the project-access reach rule", () => {
  it("narrows a ticket card read to reachable projects for a member with org-wide ticket view", async () => {
    const { db, captured } = capturingDb([
      { id: 5, title: "T", status: "TODO", ticketNumber: 1, projectId: 2, projectKey: "AB" },
    ]);
    const service = new BuildEntityReadsService(db);
    const [resolution] = await service.resolveWith(
      MEMBER,
      [{ module: "build", type: "ticket", id: "5" }],
      grants([["build:view", "own"], ["build:tickets:view", "all"]]),
    );
    expect(resolution?.status).toBe("resolved");
    const sql = sqlOf(captured[0]);
    expect(sql).toContain("project_members");
    expect(sql).toContain("project_team_assignments");
  });

  it("matches no project for a member holding ticket view but no project standing, so a ticket 404'd on the read path never renders as a card", async () => {
    const { db, captured } = capturingDb([]);
    const service = new BuildEntityReadsService(db);
    const [resolution] = await service.resolveWith(
      MEMBER,
      [{ module: "build", type: "ticket", id: "5" }],
      grants([["build:tickets:view", "all"]]),
    );
    expect(resolution?.status).not.toBe("resolved");
    const sql = sqlOf(captured[0]);
    expect(sql).not.toContain("project_members");
    expect(sql).toContain("false");
  });

  it("gives the org owner every project, matching the OWNER role of the HTTP decision", () => {
    expect(dialect.sqlToQuery(entityProjectReach(OWNER, grants([]))).sql).toBe("true");
  });

  it("refuses an entity action on a project the actor cannot reach and on an archived project, and allows an active reachable one", async () => {
    const reach = entityProjectReach(MEMBER, grants([["build:view", "own"]]));
    const decide = (rows: object[]) => entityProjectWriteRefusal(capturingDb(rows).db, MEMBER, reach, 2);
    await expect(decide([{ state: "ACTIVE", reachable: false }])).resolves.toBe("forbidden");
    await expect(decide([{ state: "ARCHIVED", reachable: true }])).resolves.toBe("forbidden");
    await expect(decide([])).resolves.toBe("not-found");
    await expect(decide([{ state: "ACTIVE", reachable: true }])).resolves.toBeNull();
  });
});
