import { and, eq, is, SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { kbArticleChunks } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import {
  attachmentChunks,
  pageDocumentChunks,
  replaceAttachmentChunks,
  replacePageDocumentChunks,
} from "./kb-derived-chunk-state";

const dialect = new PgDialect();
const ORG = "org-chunk-1";
const PAGE_ID = 41;
const ATTACHMENT_ID = 900;

function render(clause: unknown): string {
  if (!is(clause, SQL)) return "";
  return dialect.sqlToQuery(clause).sql.toLowerCase();
}

function captureInsert() {
  const values = jest.fn().mockResolvedValue([]);
  const deleteWhere = jest.fn().mockResolvedValue([]);
  const tx = {
    delete: jest.fn().mockReturnValue({ where: deleteWhere }),
    insert: jest.fn().mockReturnValue({ values }),
  };
  const db = {
    transaction: jest.fn(async (fn: (t: unknown) => Promise<void>) => fn(tx)),
  } as unknown as Db;
  return {
    db,
    rows: () => (values.mock.calls[0]?.[0] ?? []) as Record<string, unknown>[],
    deleteClause: () => deleteWhere.mock.calls[0]?.[0],
  };
}

describe("the two attachment-sourced chunk families cannot match the same row", () => {
  it("scopes a page document to rows with no attachment, so replacing it cannot wipe the page's attachments", () => {
    const sql = render(pageDocumentChunks(ORG, PAGE_ID));

    expect(sql).toContain(`"page_id"`);
    expect(sql).toContain(`"attachment_id" is null`);
  });

  it("scopes an attachment by attachment_id, which a page-document row never carries", () => {
    const sql = render(attachmentChunks(ORG, ATTACHMENT_ID));

    expect(sql).toContain(`"attachment_id"`);
    expect(sql).not.toContain(`"attachment_id" is null`);
  });

  it("BITE: the disjointness assertion rejects the overlapping predicate it exists to forbid", () => {
    const overlapping = render(
      and(
        eq(kbArticleChunks.orgId, ORG),
        eq(kbArticleChunks.pageId, PAGE_ID),
        eq(kbArticleChunks.source, "attachment"),
      ),
    );

    expect(overlapping).toContain(`"page_id"`);
    expect(overlapping).not.toContain(`"attachment_id" is null`);
  });
});

describe("a derived chunk is reachable from retrieval only if it carries its page", () => {
  it("anchors an attachment chunk to its parent page, because every candidate pass requires page_id", async () => {
    const captured = captureInsert();

    await replaceAttachmentChunks(
      captured.db,
      ORG,
      ATTACHMENT_ID,
      PAGE_ID,
      ["alpha"],
      [[0.1]],
      { contentHash: "hash-a", aclRevision: 3 },
    );

    const rows = captured.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["pageId"]).toBe(PAGE_ID);
    expect(rows[0]?.["attachmentId"]).toBe(ATTACHMENT_ID);
    expect(rows[0]?.["aclRevision"]).toBe(3);
    expect(rows[0]).not.toHaveProperty("articleId");
  });

  it("leaves attachment_id unset on a page document, which is what keeps the two families apart", async () => {
    const captured = captureInsert();

    await replacePageDocumentChunks(
      captured.db,
      ORG,
      PAGE_ID,
      ["beta"],
      [[0.2]],
      {
        contentHash: "hash-b",
        pageVisibility: "org",
        pageProjectId: null,
        pageCreatedById: "user-1",
        pageCreatedByMembershipId: 5,
        aclRevision: 3,
      },
    );

    const rows = captured.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["pageId"]).toBe(PAGE_ID);
    expect(rows[0]?.["attachmentId"]).toBeNull();
    expect(rows[0]?.["pageVisibility"]).toBe("org");
    expect(rows[0]).not.toHaveProperty("articleId");
  });

  it("deletes only its own family before reinserting, scoped by the family predicate", async () => {
    const captured = captureInsert();

    await replacePageDocumentChunks(
      captured.db,
      ORG,
      PAGE_ID,
      ["gamma"],
      [[0.3]],
      {
        contentHash: "hash-c",
        pageVisibility: "org",
        pageProjectId: null,
        pageCreatedById: null,
        pageCreatedByMembershipId: null,
        aclRevision: 1,
      },
    );

    expect(render(captured.deleteClause())).toContain(`"attachment_id" is null`);
  });
});
