jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(db),
}));

import { PgDialect } from "drizzle-orm/pg-core";
import { type SQL } from "drizzle-orm";
import { hasPublicDocumentContent, retrievePublicDocumentChunks } from "./kb-rag-documents";

const ORG = "org-rag";
const QUESTION = "how do I reset my password";
const VECTOR = "[0.1,0.2,0.3]";

const dialect = new PgDialect();

function render(cond: SQL): { text: string; params: unknown[] } {
  const { sql: text, params } = dialect.sqlToQuery(cond);
  return { text, params };
}

const chunkRow = {
  id: 1,
  articleId: 10,
  attachmentId: null,
  source: "article_body",
  content: "Steps to reset your password.",
  title: "Password reset",
  slug: "password-reset",
  attachmentName: null,
  similarity: 0.85,
};

function makeChain(rows: unknown[] = [chunkRow]): {
  db: Record<string, jest.Mock>;
  wheres: SQL[];
  orders: SQL[];
} {
  const wheres: SQL[] = [];
  const orders: SQL[] = [];
  const chain: Record<string, jest.Mock> = {
    from: jest.fn(() => chain),
    innerJoin: jest.fn(() => chain),
    leftJoin: jest.fn(() => chain),
    where: jest.fn((cond: SQL) => {
      wheres.push(cond);
      return chain;
    }),
    orderBy: jest.fn((order: SQL) => {
      orders.push(order);
      return chain;
    }),
    limit: jest.fn(() => Promise.resolve(rows)),
  };
  const db: Record<string, jest.Mock> = {
    select: jest.fn(() => chain),
  };
  return { db, wheres, orders };
}

describe("hasPublicDocumentContent — eligibility probe", () => {
  it("returns true when the org has at least one chunk satisfying the public Document predicate", async () => {
    const { db } = makeChain([{ id: 99 }]);
    const result = await hasPublicDocumentContent(db as never, ORG);
    expect(result).toBe(true);
  });

  it("returns false when no chunk satisfies the public Document predicate, so the caller can short-circuit before embedding", async () => {
    const { db } = makeChain([]);
    const result = await hasPublicDocumentContent(db as never, ORG);
    expect(result).toBe(false);
  });
});

describe("retrievePublicDocumentChunks — predicate contents", () => {
  it("requires visibility = 'public' so org-only Documents are never quoted to an anonymous asker", async () => {
    const { db, wheres } = makeChain();
    await retrievePublicDocumentChunks(db as never, ORG, null, QUESTION);
    const { text, params } = render(wheres[0] as SQL);
    const idx = /"kb_pages"\."visibility"\s*=\s*\$(\d+)/.exec(text);
    expect(idx).not.toBeNull();
    expect(params[Number(idx![1]) - 1]).toBe("public");
  });

  it("does not bind 'org' as a visibility value, confirming the predicate is strictly more restrictive than the authenticated scope for the same content type", async () => {
    const { db, wheres } = makeChain();
    await retrievePublicDocumentChunks(db as never, ORG, null, QUESTION);
    const { params } = render(wheres[0] as SQL);
    expect(params).not.toContain("org");
  });

  it("requires status = 'published' so draft and archived Documents do not reach the AI", async () => {
    const { db, wheres } = makeChain();
    await retrievePublicDocumentChunks(db as never, ORG, null, QUESTION);
    const { text, params } = render(wheres[0] as SQL);
    const idx = /"kb_pages"\."status"\s*=\s*\$(\d+)/.exec(text);
    expect(idx).not.toBeNull();
    expect(params[Number(idx![1]) - 1]).toBe("published");
  });

  it("requires space audience in ('public', 'mixed') so Documents in internal-only Spaces are never quoted to anonymous callers", async () => {
    const { db, wheres } = makeChain();
    await retrievePublicDocumentChunks(db as never, ORG, null, QUESTION);
    const { text } = render(wheres[0] as SQL);
    expect(text).toContain('"kb_spaces"."audience" in');
  });

  it("binds the caller's org_id in the chunk predicate so cross-tenant content cannot match", async () => {
    const { db, wheres } = makeChain();
    await retrievePublicDocumentChunks(db as never, ORG, null, QUESTION);
    const { params } = render(wheres[0] as SQL);
    expect(params).toContain(ORG);
  });

  it("restricts the corpus to support articles so wiki pages are never quoted to an anonymous asker", async () => {
    const { db, wheres } = makeChain();
    await retrievePublicDocumentChunks(db as never, ORG, null, QUESTION);
    const { params } = render(wheres[0] as SQL);
    expect(params).toContain("support_article");
  });

  it("requires space deleted_at IS NULL so Documents in deleted Spaces are excluded", async () => {
    const { db, wheres } = makeChain();
    await retrievePublicDocumentChunks(db as never, ORG, null, QUESTION);
    const { text } = render(wheres[0] as SQL);
    expect(text).toContain('"kb_spaces"."deleted_at" is null');
  });

  it("allows a body chunk whose attachment_id is null alongside an attachment chunk whose deleted_at is null, excluding only a soft-deleted attachment", async () => {
    const { db, wheres } = makeChain();
    await retrievePublicDocumentChunks(db as never, ORG, null, QUESTION);
    const { text } = render(wheres[0] as SQL);
    expect(text).toMatch(
      /"kb_article_chunks"\."attachment_id" is null or "kb_page_attachments"\."deleted_at" is null/,
    );
  });
});

describe("retrievePublicDocumentChunks — ranking strategy", () => {
  it("orders by vector distance when a vector is supplied, confirming the semantic path is active", async () => {
    const { db, orders } = makeChain();
    await retrievePublicDocumentChunks(db as never, ORG, VECTOR, QUESTION);
    const { text } = render(orders[0] as SQL);
    expect(text).toContain("<=>");
  });

  it("orders by ts_rank and adds a full-text match condition when no vector is supplied, confirming the lexical fallback is active", async () => {
    const { db, wheres, orders } = makeChain();
    await retrievePublicDocumentChunks(db as never, ORG, null, QUESTION);
    const orderText = render(orders[0] as SQL).text;
    const whereText = render(wheres[0] as SQL).text;
    expect(orderText).toContain("ts_rank");
    expect(whereText).toContain('"kb_pages"."fts"');
  });
});

describe("retrievePublicDocumentChunks — result shaping", () => {
  it("returns the chunk rows from the DB so the caller can build prompts", async () => {
    const { db } = makeChain([chunkRow]);
    const result = await retrievePublicDocumentChunks(db as never, ORG, null, QUESTION);
    expect(result).toHaveLength(1);
    expect(result[0]?.slug).toBe("password-reset");
  });

  it("omits a row whose slug is null so only linkable Documents appear in AI responses", async () => {
    const { db } = makeChain([{ ...chunkRow, slug: null }]);
    const result = await retrievePublicDocumentChunks(db as never, ORG, null, QUESTION);
    expect(result).toHaveLength(0);
  });

  it("returns an empty array when the DB has no matching chunks, so the caller detects a corpus miss without additional queries", async () => {
    const { db } = makeChain([]);
    const result = await retrievePublicDocumentChunks(db as never, ORG, null, QUESTION);
    expect(result).toEqual([]);
  });
});
