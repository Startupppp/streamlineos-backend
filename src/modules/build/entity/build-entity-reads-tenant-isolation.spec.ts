import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import type { DataScope } from "../../access/access.types";
import type { EntityActor } from "../../entity-reference/entity-reference.types";
import { BuildEntityReadsService } from "./build-entity-reads.service";

const dialect = new PgDialect();
const VIEWER = new Map<string, DataScope>([["build:view", "own"]]);

describe("BuildEntityReadsService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  function makeDb(rows: unknown[]) {
    const captured: SQL[] = [];
    const limit = jest.fn().mockResolvedValue(rows);
    const where = jest.fn((arg: SQL) => {
      captured.push(arg);
      return { limit };
    });
    const from = jest.fn().mockReturnValue({ where });
    const select = jest.fn().mockReturnValue({ from });
    return { db: { select } as unknown as Db, captured };
  }

  const actor = (orgId: string): EntityActor => ({ orgId, userId: "u1", membershipId: 9, isOrgOwner: false });
  const refs = (ids: number[]) => ids.map((id) => ({ type: "project", id: String(id) }));

  it("scopes project cards to the attacker's org — resolves nothing (cross-tenant isolation)", async () => {
    const { db, captured } = makeDb([]);
    const result = await new BuildEntityReadsService(db).resolveWith(actor(ATTACKER_ORG), refs([1, 2, 3]), VIEWER);
    expect(result.every((r) => r.status !== "resolved")).toBe(true);
    const where = captured[0];
    if (!where) throw new Error("no predicate");
    expect(dialect.sqlToQuery(where).params).toContain(ATTACKER_ORG);
  });

  it("resolves reachable project cards for the owning org (same-tenant control)", async () => {
    const { db } = makeDb([
      { id: 1, name: "A", key: "A", status: "ACTIVE" },
      { id: 2, name: "B", key: "B", status: "ACTIVE" },
    ]);
    const result = await new BuildEntityReadsService(db).resolveWith(actor(OWNER_ORG), refs([1, 2]), VIEWER);
    expect(result.filter((r) => r.status === "resolved")).toHaveLength(2);
  });
});
