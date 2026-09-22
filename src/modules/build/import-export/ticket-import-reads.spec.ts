import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import {
  nextTicketNumber,
  readConflictingTitleKeys,
  readProjectStatusNames,
} from "./ticket-import-reads";

const ORG = "11111111-1111-4111-8111-111111111111";
const dialect = new PgDialect();

interface Capture {
  where: SQL | undefined;
  selects: number;
}

function fakeDb(rows: unknown[]): { db: DbOrTx; capture: Capture } {
  const capture: Capture = { where: undefined, selects: 0 };
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    from: () => chain,
    where: (condition: SQL) => {
      capture.where = condition;
      return chain;
    },
    orderBy: () => chain,
    then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  });
  const db = {
    select: () => {
      capture.selects += 1;
      return chain;
    },
  };
  return { db: db as unknown as DbOrTx, capture };
}

function rendered(capture: Capture): { sql: string; params: unknown[] } {
  if (!capture.where) throw new Error("No predicate was captured");
  const query = dialect.sqlToQuery(capture.where);
  return { sql: query.sql, params: query.params };
}

describe("readProjectStatusNames", () => {
  it("returns the configured names in order", async () => {
    const { db } = fakeDb([{ name: "TODO" }, { name: "DONE" }]);
    await expect(readProjectStatusNames(db, ORG, 42)).resolves.toEqual(["TODO", "DONE"]);
  });

  it("scopes the read to the organisation and the project", async () => {
    const { db, capture } = fakeDb([]);
    await readProjectStatusNames(db, ORG, 42);
    const query = rendered(capture);
    expect(query.sql).toContain("org_id");
    expect(query.sql).toContain("project_id");
    expect(query.params).toEqual([ORG, 42]);
  });
});

describe("readConflictingTitleKeys", () => {
  it("issues no query when the file offers no titles", async () => {
    const { db, capture } = fakeDb([]);
    await expect(readConflictingTitleKeys(db, ORG, 42, [])).resolves.toEqual([]);
    expect(capture.selects).toBe(0);
  });

  it("scopes the lookup to the organisation, the project and live rows", async () => {
    const { db, capture } = fakeDb([{ key: "ship it" }]);
    await expect(readConflictingTitleKeys(db, ORG, 42, ["ship it"])).resolves.toEqual([
      "ship it",
    ]);
    const query = rendered(capture);
    expect(query.sql).toContain("org_id");
    expect(query.sql).toContain("project_id");
    expect(query.sql).toContain("deleted_at");
    expect(query.params).toEqual([ORG, 42, "ship it"]);
  });

  it("normalises the stored title the same way the preview normalises the file", async () => {
    const { db, capture } = fakeDb([]);
    await readConflictingTitleKeys(db, ORG, 42, ["ship it"]);
    expect(rendered(capture).sql).toContain("regexp_replace(lower(btrim(");
  });
});

describe("nextTicketNumber", () => {
  it("continues from the highest number already allocated", async () => {
    const { db } = fakeDb([{ value: 7 }]);
    await expect(nextTicketNumber(db, ORG, 42)).resolves.toBe(8);
  });

  it("starts at one for a project with no tickets", async () => {
    const { db } = fakeDb([{ value: null }]);
    await expect(nextTicketNumber(db, ORG, 42)).resolves.toBe(1);
  });

  it("counts soft deleted rows, which still hold their slot in the unique index", async () => {
    const { db, capture } = fakeDb([{ value: 3 }]);
    await nextTicketNumber(db, ORG, 42);
    expect(rendered(capture).sql).not.toContain("deleted_at");
  });
});
