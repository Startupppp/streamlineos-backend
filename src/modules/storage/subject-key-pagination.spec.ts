import { PgDialect } from "drizzle-orm/pg-core";
import {
  SUBJECT_KEY_PAGE_LIMIT,
  buildSubjectKeyQuery,
  collectSubjectFileKeysWithLegalHold,
  collectOrgFileKeys,
  collectUserFileKeys,
  enumerateFileKeyColumns,
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

describe("collectOrgFileKeys — parameterized SQL (S5)", () => {
  it("uses a $1 placeholder for orgId rather than inlining it — injection-safe", async () => {
    const dialect = new PgDialect();
    let capturedQuery: { sql: string; params: unknown[] } | undefined;

    const db = {
      execute: jest.fn((q: unknown) => {
        capturedQuery = dialect.sqlToQuery(q as Parameters<typeof dialect.sqlToQuery>[0]);
        return Promise.resolve([]);
      }),
    } as unknown as Db;

    const columns: FileKeyColumn[] = [{ table: "public.documents", column: "file_url" }];
    await collectOrgFileKeys(db, "org-with'quote", columns);

    expect(capturedQuery).toBeDefined();
    expect(capturedQuery?.sql).toContain("$1");
    expect(capturedQuery?.sql).not.toContain("org-with");
    expect(capturedQuery?.params).toContain("org-with'quote");
  });
});

describe("collectUserFileKeys — parameterized SQL (S5)", () => {
  it("uses a $1 placeholder for userId rather than inlining it — injection-safe", async () => {
    const dialect = new PgDialect();
    let capturedQuery: { sql: string; params: unknown[] } | undefined;

    const db = {
      execute: jest.fn((q: unknown) => {
        capturedQuery = dialect.sqlToQuery(q as Parameters<typeof dialect.sqlToQuery>[0]);
        return Promise.resolve([]);
      }),
    } as unknown as Db;

    const columns: FileKeyColumn[] = [{ table: "public.documents", column: "file_url" }];
    await collectUserFileKeys(db, "user-id'injected", columns);

    expect(capturedQuery).toBeDefined();
    expect(capturedQuery?.sql).toContain("$1");
    expect(capturedQuery?.sql).not.toContain("user-id");
    expect(capturedQuery?.params).toContain("user-id'injected");
  });
});

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

describe("enumerateFileKeyColumns — schema filter renders valid SQL", () => {
  function captureDb(): { db: Db; rendered: () => { sql: string; params: unknown[] } } {
    let captured: { sql: string; params: unknown[] } | null = null;
    const db = {
      execute: (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
        const q = dialect.sqlToQuery(query);
        captured = { sql: q.sql, params: [...q.params] };
        return Promise.resolve([]);
      },
    } as unknown as Db;
    return {
      db,
      rendered: () => {
        if (!captured) throw new Error("query was never executed");
        return captured;
      },
    };
  }

  it("renders an IN list, not `= ANY(row constructor)` which Postgres rejects with 42809", async () => {
    const { db, rendered } = captureDb();
    await enumerateFileKeyColumns(db);
    const { sql: text, params } = rendered();

    expect(text).toContain("n.nspname IN ($1, $2, $3)");
    expect(text).not.toMatch(/ANY\s*\(\s*\(/);
    expect(params).toEqual(["public", "build", "build_events"]);
  });

  it("parameterizes every schema name rather than inlining it", async () => {
    const { db, rendered } = captureDb();
    await enumerateFileKeyColumns(db);
    const { sql: text } = rendered();

    expect(text).not.toContain("'public'");
    expect(text).not.toContain("'build_events'");
  });
});
