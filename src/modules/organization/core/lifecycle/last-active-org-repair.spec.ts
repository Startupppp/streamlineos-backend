import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { DbOrTx } from "../../../../common/rbac/access-invalidate";
import { repairLastActiveOrgIds } from "./last-active-org-repair";

const dialect = new PgDialect();
const ORG = "org-being-archived";

function makeDb() {
  const statements: SQL[] = [];
  const indexWheres: unknown[] = [];
  const db = {
    execute: (statement: SQL) => {
      statements.push(statement);
      return Promise.resolve([]);
    },
    update: () => ({
      set: () => ({
        where: (condition: unknown) => {
          indexWheres.push(condition);
          return Promise.resolve([]);
        },
      }),
    }),
  } as unknown as DbOrTx;
  return { db, statements, indexWheres };
}

function replacementsOf(count: number): Map<string, string | null> {
  return new Map(
    Array.from({ length: count }, (_, i) => [`user-${String(i)}`, i % 2 === 0 ? `next-org-${String(i)}` : null]),
  );
}

describe("repairLastActiveOrgIds — one statement per chunk, not two per member", () => {
  it("moves 300 members with ONE users statement and ONE index statement, not 600", async () => {
    const { db, statements, indexWheres } = makeDb();

    await repairLastActiveOrgIds(db, ORG, replacementsOf(300));

    expect(statements).toHaveLength(1);
    expect(indexWheres).toHaveLength(1);
  });

  it("keeps last_active_org_id as the tenant predicate — a member who already moved on is not stamped", async () => {
    const { db, statements } = makeDb();

    await repairLastActiveOrgIds(db, ORG, replacementsOf(3));

    const query = dialect.sqlToQuery(statements[0] as SQL);
    expect(query.sql).toContain('"users"."last_active_org_id" =');
    expect(query.sql).not.toContain('"users"."org_id"');
    expect(query.params).toContain(ORG);
  });

  it("carries every member's own replacement org in the one statement", async () => {
    const { db, statements } = makeDb();

    await repairLastActiveOrgIds(db, ORG, replacementsOf(4));

    const query = dialect.sqlToQuery(statements[0] as SQL);
    for (const id of ["user-0", "user-1", "user-2", "user-3"]) expect(query.params).toContain(id);
    expect(query.params).toContain("next-org-0");
    expect(query.params).toContain("next-org-2");
    expect(query.params).toContain(null);
  });

  it("issues nothing at all when no member has to move", async () => {
    const { db, statements, indexWheres } = makeDb();

    await repairLastActiveOrgIds(db, ORG, new Map());

    expect(statements).toHaveLength(0);
    expect(indexWheres).toHaveLength(0);
  });
});
