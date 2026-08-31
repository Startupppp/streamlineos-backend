import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import {
  buildSubjectKeyQuery,
  collectSubjectFileKeysWithLegalHold,
  SUBJECT_KEY_PAGE_LIMIT,
  type FileKeyColumn,
} from "../storage/storage-key-catalog";

const USER_ID = "user-subject-111";
const ORG_A = "org-aaa";
const ORG_B = "org-bbb";

function renderSql(q: SQL): string {
  return new PgDialect().sqlToQuery(q).sql;
}

describe("buildSubjectKeyQuery — legal-hold predicate", () => {
  it("includes the hr_legal_holds exclusion in a user-col query", () => {
    const q = buildSubjectKeyQuery(
      "public.kb_article_attachments",
      "file_key",
      "uploaded_by",
      USER_ID,
      USER_ID,
      "user-col",
    );
    const rendered = renderSql(q);
    expect(rendered).toContain("hr_legal_holds");
    expect(rendered).toContain("subject_user_id");
    expect(rendered).toContain("status = 'active'");
    expect(rendered).toContain("deleted_at IS NULL");
  });

  it("includes the hr_legal_holds exclusion in an org-id query", () => {
    const q = buildSubjectKeyQuery(
      "public.chat_attachments",
      "file_key",
      "org_id",
      [ORG_A, ORG_B],
      USER_ID,
      "org-id",
    );
    const rendered = renderSql(q);
    expect(rendered).toContain("hr_legal_holds");
    expect(rendered).toContain("subject_user_id");
    expect(rendered).toContain("status = 'active'");
    expect(rendered).toContain("deleted_at IS NULL");
  });

  it("scopes the legal-hold check to the correct subject user id", () => {
    const q = buildSubjectKeyQuery(
      "public.sign_documents",
      "original_file_key",
      "created_by",
      USER_ID,
      USER_ID,
      "user-col",
    );
    const { sql: rendered, params } = new PgDialect().sqlToQuery(q);
    expect(rendered).toContain("subject_user_id");
    expect(params).toContain(USER_ID);
  });
});

describe("collectSubjectFileKeysWithLegalHold — integration with mocked db", () => {
  const SAMPLE_COLUMNS: FileKeyColumn[] = [
    { table: "public.kb_article_attachments", column: "file_key" },
    { table: "public.chat_attachments", column: "file_key" },
  ];

  function makeMockDb(options: {
    userFkRows: Array<{ table: string; col: string }>;
    keyRows: Array<{ k: string }>;
    capturedSql?: string[];
  }): Db {
    return {
      execute: jest.fn(async (q: SQL) => {
        const rendered = renderSql(q);
        if (options.capturedSql) options.capturedSql.push(rendered);
        if (rendered.includes("pg_constraint")) return options.userFkRows;
        return options.keyRows;
      }),
    } as unknown as Db;
  }

  it("legal-hold predicate is present in every file-key enumeration query — FAILS if predicate is removed", async () => {
    const capturedSql: string[] = [];
    const db = makeMockDb({
      userFkRows: [
        { table: "public.kb_article_attachments", col: "uploaded_by" },
      ],
      keyRows: [],
      capturedSql,
    });

    await collectSubjectFileKeysWithLegalHold(db, USER_ID, [ORG_A], SAMPLE_COLUMNS);

    const enumerationQueries = capturedSql.filter((q) => !q.includes("pg_constraint"));
    expect(enumerationQueries.length).toBeGreaterThan(0);
    for (const q of enumerationQueries) {
      expect(q).toContain("hr_legal_holds");
    }
  });

  it("returns an empty list when the db applies the legal-hold predicate (no rows returned)", async () => {
    const db = makeMockDb({
      userFkRows: [{ table: "public.kb_article_attachments", col: "uploaded_by" }],
      keyRows: [],
    });

    const keys = await collectSubjectFileKeysWithLegalHold(db, USER_ID, [ORG_A], SAMPLE_COLUMNS);
    expect(keys).toHaveLength(0);
  });

  it("returns keys when no legal hold is active (db returns rows for all queries)", async () => {
    const db = makeMockDb({
      userFkRows: [{ table: "public.kb_article_attachments", col: "uploaded_by" }],
      keyRows: [{ k: "documents/user-subject-111-resume.pdf" }],
    });

    const keys = await collectSubjectFileKeysWithLegalHold(
      db,
      USER_ID,
      [ORG_A],
      [{ table: "public.kb_article_attachments", column: "file_key" }],
    );
    expect(keys.map((k) => k.key)).toContain("documents/user-subject-111-resume.pdf");
  });

  it("uses org-id fallback for tables with no direct FK to users and still includes legal-hold predicate", async () => {
    const capturedSql: string[] = [];
    const db = makeMockDb({
      userFkRows: [],
      keyRows: [],
      capturedSql,
    });

    await collectSubjectFileKeysWithLegalHold(
      db,
      USER_ID,
      [ORG_A],
      [{ table: "public.chat_attachments", column: "file_key" }],
    );

    const enumerationQueries = capturedSql.filter((q) => !q.includes("pg_constraint"));
    expect(enumerationQueries.length).toBeGreaterThan(0);
    for (const q of enumerationQueries) {
      expect(q).toContain("hr_legal_holds");
      expect(q).toContain("org_id");
    }
  });

  it("deduplicates keys that appear in multiple tables", async () => {
    const SHARED_KEY = "shared/file.pdf";
    const db = makeMockDb({
      userFkRows: [
        { table: "public.kb_article_attachments", col: "uploaded_by" },
        { table: "public.sign_documents", col: "created_by" },
      ],
      keyRows: [{ k: SHARED_KEY }],
    });

    const keys = await collectSubjectFileKeysWithLegalHold(db, USER_ID, [], [
      { table: "public.kb_article_attachments", column: "file_key" },
      { table: "public.sign_documents", column: "original_file_key" },
    ]);

    const allKeys = keys.map((k) => k.key);
    expect(allKeys.filter((k) => k === SHARED_KEY)).toHaveLength(1);
  });
});

describe("buildSubjectKeyQuery — Item A: per-table LIMIT bounds each call (no unbounded listing)", () => {
  it("(bite proof) user-col query contains LIMIT clause — removing SUBJECT_KEY_PAGE_LIMIT would make this fail", () => {
    const q = buildSubjectKeyQuery(
      "public.hr_documents",
      "file_key",
      "user_id",
      USER_ID,
      USER_ID,
      "user-col",
    );
    const rendered = renderSql(q);
    expect(rendered.toUpperCase()).toContain("LIMIT");
    expect(rendered).toContain(String(SUBJECT_KEY_PAGE_LIMIT));
  });

  it("(bite proof) org-id query contains LIMIT clause — removing SUBJECT_KEY_PAGE_LIMIT would make this fail", () => {
    const q = buildSubjectKeyQuery(
      "public.chat_attachments",
      "file_key",
      "org_id",
      [ORG_A, ORG_B],
      USER_ID,
      "org-id",
    );
    const rendered = renderSql(q);
    expect(rendered.toUpperCase()).toContain("LIMIT");
    expect(rendered).toContain(String(SUBJECT_KEY_PAGE_LIMIT));
  });

  it("SUBJECT_KEY_PAGE_LIMIT is a positive finite number", () => {
    expect(typeof SUBJECT_KEY_PAGE_LIMIT).toBe("number");
    expect(SUBJECT_KEY_PAGE_LIMIT).toBeGreaterThan(0);
    expect(Number.isFinite(SUBJECT_KEY_PAGE_LIMIT)).toBe(true);
  });

  it("catalog adapter cannot list by org prefix — each call is bounded by LIMIT, not by S3 ListObjectsV2", () => {
    const q = buildSubjectKeyQuery(
      "public.hr_documents",
      "file_key",
      "user_id",
      USER_ID,
      USER_ID,
      "user-col",
    );
    const rendered = renderSql(q);
    expect(rendered).not.toContain("ListObjectsV2");
    expect(rendered.toUpperCase()).toContain("LIMIT");
  });
});
