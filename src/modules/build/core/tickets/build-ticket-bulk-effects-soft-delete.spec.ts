import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.types";
import { readBulkTicketMeta } from "./build-ticket-bulk-effects";

const dialect = new PgDialect();
const render = (value: unknown) => dialect.sqlToQuery(value as SQL).sql;

function makeSelectDb(rows: readonly unknown[]) {
  const captured: { where?: unknown } = {};
  const db = {
    select: () => ({
      from: () => ({
        where: (condition: unknown) => {
          captured.where = condition;
          return { limit: () => Promise.resolve(rows) };
        },
      }),
    }),
  } as unknown as Db;
  return { db, captured };
}

describe("readBulkTicketMeta — soft-delete filtering (BE-50)", () => {
  it("filters the bulk effect meta read on tickets.deleted_at, so a retired ticket cannot be notified on", async () => {
    const { db, captured } = makeSelectDb([]);

    await readBulkTicketMeta(db, "org-1", [1, 2]);

    expect(render(captured.where)).toContain('"build"."tickets"."deleted_at" is null');
  });

  it("still binds the caller's organisation and the requested ids alongside the lifecycle predicate", async () => {
    const { db, captured } = makeSelectDb([]);

    await readBulkTicketMeta(db, "org-1", [1, 2, 2]);

    const sql = render(captured.where);
    expect(sql).toContain('"build"."tickets"."org_id" = $1');
    expect(sql).toContain('"build"."tickets"."id" in ($2, $3)');
  });

  it("issues no query at all for an empty id list", async () => {
    const { db, captured } = makeSelectDb([]);

    const meta = await readBulkTicketMeta(db, "org-1", []);

    expect(meta.size).toBe(0);
    expect(captured.where).toBeUndefined();
  });
});
