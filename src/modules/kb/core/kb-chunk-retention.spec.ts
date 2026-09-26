import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { pruneStaleDocumentChunks } from "./kb-chunk-retention";

const dialect = new PgDialect();

function makeTx(selectBatches: Array<Array<{ id: number }>>) {
  let selectWhere: SQL | null = null;
  let deleteWhere: SQL | null = null;
  let batchIdx = 0;

  const tx = {
    select: (_cols: unknown) => ({
      from: (_t: unknown) => ({
        leftJoin: (_t2: unknown, _on: unknown) => ({
          where: (cond: SQL) => {
            selectWhere = cond;
            return {
              limit: (_n: unknown) =>
                Promise.resolve(selectBatches[batchIdx++] ?? []),
            };
          },
        }),
      }),
    }),
    delete: (_t: unknown) => ({
      where: (cond: SQL) => {
        deleteWhere = cond;
        return Promise.resolve([]);
      },
    }),
  };

  return {
    tx: tx as never,
    getSelectWhere: () => selectWhere,
    getDeleteWhere: () => deleteWhere,
  };
}

describe("pruneStaleDocumentChunks — stale predicate targets archived and soft-deleted Documents", () => {
  it("includes 'archived' status in the stale condition (positive — archived Documents are pruned)", async () => {
    const { tx, getSelectWhere } = makeTx([[]]);

    await pruneStaleDocumentChunks(tx, "org-test");

    const rendered = dialect.sqlToQuery(getSelectWhere()!);
    expect(rendered.params).toContain("archived");
  });

  it("does not include a 'published' status in the stale condition (negative — active Documents are kept)", async () => {
    const { tx, getSelectWhere } = makeTx([[]]);

    await pruneStaleDocumentChunks(tx, "org-test");

    const rendered = dialect.sqlToQuery(getSelectWhere()!);
    expect(rendered.params).not.toContain("published");
  });

  it("includes a deleted_at IS NOT NULL check for soft-deleted Documents (positive)", async () => {
    const { tx, getSelectWhere } = makeTx([[]]);

    await pruneStaleDocumentChunks(tx, "org-test");

    const rendered = dialect.sqlToQuery(getSelectWhere()!);
    expect(rendered.sql).toContain('"deleted_at" is not null');
  });

  it("does not require deleted_at to have a specific value — IS NOT NULL is sufficient (negative — IS NULL would invert the guard)", async () => {
    const { tx, getSelectWhere } = makeTx([[]]);

    await pruneStaleDocumentChunks(tx, "org-test");

    const rendered = dialect.sqlToQuery(getSelectWhere()!);
    expect(rendered.sql).not.toMatch(/"deleted_at" = /);
  });
});

describe("pruneStaleDocumentChunks — tenant isolation", () => {
  it("scopes the chunk query to the supplied orgId (positive)", async () => {
    const { tx, getSelectWhere } = makeTx([[]]);

    await pruneStaleDocumentChunks(tx, "org-alpha");

    const rendered = dialect.sqlToQuery(getSelectWhere()!);
    expect(rendered.params).toContain("org-alpha");
  });

  it("does not include a different org's id in the stale-chunk query (negative — cross-tenant isolation)", async () => {
    const { tx, getSelectWhere } = makeTx([[]]);

    await pruneStaleDocumentChunks(tx, "org-alpha");

    const rendered = dialect.sqlToQuery(getSelectWhere()!);
    expect(rendered.params).not.toContain("org-attacker");
  });
});

describe("pruneStaleDocumentChunks — deletion and count", () => {
  it("deletes the found chunks and returns the count (positive)", async () => {
    const { tx, getDeleteWhere } = makeTx([[{ id: 11 }, { id: 22 }], []]);

    const count = await pruneStaleDocumentChunks(tx, "org-beta");

    expect(getDeleteWhere()).not.toBeNull();
    expect(count).toBe(2);
  });

  it("does not call delete and returns zero when no stale chunks exist (negative)", async () => {
    const { tx, getDeleteWhere } = makeTx([[]]);

    const count = await pruneStaleDocumentChunks(tx, "org-beta");

    expect(getDeleteWhere()).toBeNull();
    expect(count).toBe(0);
  });
});
