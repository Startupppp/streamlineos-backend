import { PgDialect } from "drizzle-orm/pg-core";
import {
  SUBJECT_KEY_PAGE_LIMIT,
  buildSubjectKeyQuery,
  collectSubjectFileKeysWithLegalHold,
  type FileKeyColumn,
} from "./storage-key-catalog";
import type { Db } from "../../db/drizzle.module";

const dialect = new PgDialect();
const render = (q: ReturnType<typeof buildSubjectKeyQuery>) => dialect.sqlToQuery(q);

const USER = "user-1";
const COLUMNS: FileKeyColumn[] = [{ table: "public.docs", column: "file_key" }];

function keyPage(from: number, count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({ k: `key-${String(from + i).padStart(6, "0")}` }));
}

function buildDb(pages: Array<Array<Record<string, unknown>>>) {
  const executed: string[] = [];
  let pageIdx = 0;
  const db = {
    execute: jest.fn((q: ReturnType<typeof buildSubjectKeyQuery>) => {
      const renderedSql = render(q).sql;
      executed.push(renderedSql);
      if (renderedSql.includes("pg_constraint"))
        return Promise.resolve([{ table: "public.docs", col: "user_id" }]);
      if (renderedSql.includes("a.attname = 'org_id'"))
        return Promise.resolve([{ table: "public.docs" }]);
      const page = pages[pageIdx] ?? [];
      pageIdx += 1;
      return Promise.resolve(page);
    }),
  };
  return { db: db as unknown as Db, executed };
}

describe("subject file-key enumeration drains every page", () => {
  it("orders by the key column so the cursor is deterministic", () => {
    const { sql } = render(
      buildSubjectKeyQuery("public.docs", "file_key", "user_id", USER, USER, "user-col", true),
    );

    expect(sql).toContain('ORDER BY "file_key" ASC');
  });

  it("carries no cursor predicate on the first page", () => {
    const { sql } = render(
      buildSubjectKeyQuery("public.docs", "file_key", "user_id", USER, USER, "user-col", true),
    );

    expect(sql).not.toContain('"file_key" >');
  });

  it("advances with a strict greater-than on the key column", () => {
    const { sql } = render(
      buildSubjectKeyQuery("public.docs", "file_key", "user_id", USER, USER, "user-col", true, "key-000042"),
    );

    expect(sql).toContain('"file_key" >');
    expect(sql).not.toContain('"file_key" >=');
  });

  it("keeps the legal-hold exclusion in the predicate on a later page too", () => {
    const { sql } = render(
      buildSubjectKeyQuery("public.docs", "file_key", "user_id", USER, USER, "user-col", true, "key-000042"),
    );

    expect(sql).toContain("hr_legal_holds");
  });

  it("collects a subject with more keys than one page, instead of stopping at the cap", async () => {
    const full = keyPage(0, SUBJECT_KEY_PAGE_LIMIT);
    const tail = keyPage(SUBJECT_KEY_PAGE_LIMIT, 3);
    const { db } = buildDb([full, tail]);

    const result = await collectSubjectFileKeysWithLegalHold(db, USER, [], COLUMNS, ["public"]);

    expect(result).toHaveLength(SUBJECT_KEY_PAGE_LIMIT + 3);
  });

  it("stops after a short page rather than querying forever", async () => {
    const { db } = buildDb([keyPage(0, 2)]);

    const result = await collectSubjectFileKeysWithLegalHold(db, USER, [], COLUMNS, ["public"]);

    expect(result).toHaveLength(2);
  });

  it("does not re-emit a key already seen on an earlier page", async () => {
    const full = keyPage(0, SUBJECT_KEY_PAGE_LIMIT);
    const overlapping = [{ k: "key-000000" }, { k: "key-999999" }];
    const { db } = buildDb([full, overlapping]);

    const result = await collectSubjectFileKeysWithLegalHold(db, USER, [], COLUMNS, ["public"]);

    expect(result).toHaveLength(SUBJECT_KEY_PAGE_LIMIT + 1);
  });
});
