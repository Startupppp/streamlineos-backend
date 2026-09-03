import { PgDialect } from "drizzle-orm/pg-core";
import { eq, type SQL } from "drizzle-orm";
import { bulkUpdateFromValues, BULK_UPDATE_CHUNK } from "./bulk-update";
import { tickets } from "../../db/schema";
import type { Db } from "../../db/drizzle.types";

const dialect = new PgDialect();

function makeExecutor(captured: SQL[], returned: Array<{ key: string | number }> = []) {
  const execute = jest.fn().mockImplementation((statement: SQL) => {
    captured.push(statement);
    return Promise.resolve(returned);
  });
  return { executor: { execute } as unknown as Db, execute };
}

describe("bulkUpdateFromValues", () => {
  it("puts org_id in the WHERE unconditionally — the join key alone is a surrogate id", async () => {
    const captured: SQL[] = [];
    const { executor } = makeExecutor(captured);

    await bulkUpdateFromValues(executor, {
      table: tickets,
      orgId: "org-1",
      key: { column: "id", type: "integer" },
      columns: [{ column: "assignee_membership_id", type: "integer" }],
      rows: [{ key: 10, values: [7] }],
    });

    expect(captured).toHaveLength(1);
    const query = dialect.sqlToQuery(captured[0] as SQL);
    expect(query.sql).toContain('"tickets"."org_id" =');
    expect(query.params).toContain("org-1");
  });

  it("refuses a repeated key instead of letting Postgres discard rows silently", async () => {
    const captured: SQL[] = [];
    const { executor, execute } = makeExecutor(captured);

    await expect(
      bulkUpdateFromValues(executor, {
        table: tickets,
        orgId: "org-1",
        key: { column: "id", type: "integer" },
        columns: [{ column: "assignee_membership_id", type: "integer" }],
        rows: [
          { key: 10, values: [7] },
          { key: 10, values: [8] },
        ],
      }),
    ).rejects.toThrow(/appears twice/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses a type name that is not a bare Postgres type — the cast is raw SQL", async () => {
    const captured: SQL[] = [];
    const { executor, execute } = makeExecutor(captured);

    await expect(
      bulkUpdateFromValues(executor, {
        table: tickets,
        orgId: "org-1",
        key: { column: "id", type: "integer" },
        columns: [{ column: "assignee_membership_id", type: "integer) FROM x --" }],
        rows: [{ key: 10, values: [7] }],
      }),
    ).rejects.toThrow(/not a usable Postgres type/);
    expect(execute).not.toHaveBeenCalled();
  });

  /**
   * The `::type` cast is the one fragment this builder emits through `sql.raw`,
   * i.e. verbatim into the statement text. The character class alone would admit
   * any bare word; these assert the second gate — the name has to be one the
   * target table's own Drizzle declaration carries, or a base Postgres type.
   */
  it("refuses a cast type the target table does not declare, even a syntactically valid one", async () => {
    const captured: SQL[] = [];
    const { executor, execute } = makeExecutor(captured);

    for (const type of ["pg_authid", "acc_asset_status", "regclass"]) {
      await expect(
        bulkUpdateFromValues(executor, {
          table: tickets,
          orgId: "org-1",
          key: { column: "id", type: "integer" },
          columns: [{ column: "assignee_membership_id", type }],
          rows: [{ key: 10, values: [7] }],
        }),
      ).rejects.toThrow(/is not a cast type tickets declares/);
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses a set, key, touch or tenant column that is not a column of the table", async () => {
    const captured: SQL[] = [];
    const { executor, execute } = makeExecutor(captured);
    const base = {
      table: tickets,
      orgId: "org-1",
      key: { column: "id", type: "integer" },
      columns: [{ column: "assignee_membership_id", type: "integer" }],
      rows: [{ key: 10, values: [7] }],
    } as const;

    await expect(
      bulkUpdateFromValues(executor, { ...base, columns: [{ column: "password_hash", type: "text" }] }),
    ).rejects.toThrow(/set column "password_hash" is not a column of tickets/);
    await expect(
      bulkUpdateFromValues(executor, { ...base, key: { column: "rowid", type: "integer" } }),
    ).rejects.toThrow(/key column "rowid" is not a column of tickets/);
    await expect(bulkUpdateFromValues(executor, { ...base, touch: ["touched_at"] })).rejects.toThrow(
      /touch column "touched_at" is not a column of tickets/,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("CONTROL: the checks are not a blanket deny — every real column and base type still runs", async () => {
    const captured: SQL[] = [];
    const { executor, execute } = makeExecutor(captured);

    await expect(
      bulkUpdateFromValues(executor, {
        table: tickets,
        orgId: "org-1",
        key: { column: "id", type: "integer" },
        columns: [{ column: "assignee_membership_id", type: "integer" }],
        rows: [{ key: 10, values: [7] }],
        touch: ["updated_at"],
      }),
    ).resolves.toEqual([]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("refuses a tenant column the table does not have, so the predicate cannot silently vanish", async () => {
    const captured: SQL[] = [];
    const { executor, execute } = makeExecutor(captured);

    await expect(
      bulkUpdateFromValues(executor, {
        table: tickets,
        orgId: "org-1",
        key: { column: "id", type: "integer" },
        columns: [{ column: "assignee_membership_id", type: "integer" }],
        rows: [{ key: 10, values: [7] }],
        orgColumn: "tenant_id",
      }),
    ).rejects.toThrow(/tenant column "tenant_id" is not a column of tickets/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("chunks under BULK_UPDATE_CHUNK rather than issuing one unbounded statement", async () => {
    const captured: SQL[] = [];
    const { executor } = makeExecutor(captured);
    const rows = Array.from({ length: BULK_UPDATE_CHUNK + 1 }, (_, i) => ({
      key: i + 1,
      values: [i + 1],
    }));

    await bulkUpdateFromValues(executor, {
      table: tickets,
      orgId: "org-1",
      key: { column: "id", type: "integer" },
      columns: [{ column: "assignee_membership_id", type: "integer" }],
      rows,
    });

    expect(captured).toHaveLength(2);
  });

  it("carries a caller's compare-and-set through extraWhere", async () => {
    const captured: SQL[] = [];
    const { executor } = makeExecutor(captured);

    await bulkUpdateFromValues(executor, {
      table: tickets,
      orgId: "org-1",
      key: { column: "id", type: "integer" },
      columns: [{ column: "assignee_membership_id", type: "integer" }],
      rows: [{ key: 10, values: [7] }],
      extraWhere: eq(tickets.status, "TODO"),
    });

    const query = dialect.sqlToQuery(captured[0] as SQL);
    expect(query.sql).toContain('"status"');
    expect(query.params).toContain("TODO");
  });
});
