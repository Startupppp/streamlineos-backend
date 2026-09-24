import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import { kbArticles, kbPages, kbSpaces } from "../../../db/schema";
import { KbIndexingService } from "./kb-indexing.service";
import { KbSpacesService } from "../wiki/kb-spaces.service";

const dialect = new PgDialect();
const ORG = "org-survival";
const SPACE = 7;
const OTHER_SPACE = 8;
const PAGE = 100;
const ARTICLE = 200;
const OTHER_PAGE = 101;

interface PageRow {
  spaceId: number;
  aclRevision: number;
}
interface ChunkRow {
  pageId: number | null;
  articleId: number | null;
  aclRevision: number;
}

function render(node: unknown): { text: string; params: unknown[] } {
  const q = dialect.sqlToQuery(node as SQL);
  return { text: q.sql, params: q.params };
}

class KbStore {
  readonly pages = new Map<number, PageRow>();
  readonly articles = new Map<number, PageRow>();
  readonly chunks: ChunkRow[] = [];

  seed(): void {
    this.pages.set(PAGE, { spaceId: SPACE, aclRevision: 1 });
    this.pages.set(OTHER_PAGE, { spaceId: OTHER_SPACE, aclRevision: 1 });
    this.articles.set(ARTICLE, { spaceId: SPACE, aclRevision: 1 });
    this.chunks.push({ pageId: PAGE, articleId: null, aclRevision: 1 });
    this.chunks.push({ pageId: OTHER_PAGE, articleId: null, aclRevision: 1 });
    this.chunks.push({ pageId: null, articleId: ARTICLE, aclRevision: 1 });
  }

  searchablePageIds(): number[] {
    const ids = new Set<number>();
    for (const chunk of this.chunks) {
      if (chunk.pageId === null) continue;
      const page = this.pages.get(chunk.pageId);
      if (page !== undefined && page.aclRevision === chunk.aclRevision) ids.add(chunk.pageId);
    }
    return [...ids].sort((a, b) => a - b);
  }

  searchableArticleIds(): number[] {
    const ids = new Set<number>();
    for (const chunk of this.chunks) {
      if (chunk.articleId === null) continue;
      const article = this.articles.get(chunk.articleId);
      if (article !== undefined && article.aclRevision === chunk.aclRevision)
        ids.add(chunk.articleId);
    }
    return [...ids].sort((a, b) => a - b);
  }
}

function makeDb(store: KbStore) {
  const bumpedTables: string[] = [];
  const syncedTables: string[] = [];

  const applyBump = (rows: Map<number, PageRow>, spaceId: number): void => {
    for (const row of rows.values()) if (row.spaceId === spaceId) row.aclRevision += 1;
  };

  const update = (table: unknown) => ({
    set: (values: Record<string, unknown>) => ({
      where: (cond: unknown) => {
        const { text, params } = render(cond);
        const run = (): void => {
          if (table === kbSpaces) return;
          const setSql = render(values.aclRevision).text;
          expect(setSql).toContain("acl_revision + 1");
          expect(text).toContain("org_id");
          expect(text).toContain("space_id");
          expect(params[0]).toBe(ORG);
          const spaceId = params[1];
          if (typeof spaceId !== "number") throw new Error("space predicate lost its parameter");
          if (table === kbPages) {
            bumpedTables.push("kb_pages");
            applyBump(store.pages, spaceId);
          } else if (table === kbArticles) {
            bumpedTables.push("kb_articles");
            applyBump(store.articles, spaceId);
          }
        };
        const settled = Promise.resolve().then(() => {
          run();
          return [];
        });
        return {
          then: settled.then.bind(settled),
          catch: settled.catch.bind(settled),
          returning: () =>
            Promise.resolve([{ id: SPACE, orgId: ORG, audience: "internal", name: "Space" }]),
        };
      },
    }),
  });

  const execute = jest.fn().mockImplementation(async (node: unknown) => {
    const { text, params } = render(node);
    expect(text).toContain("kb_article_chunks");
    expect(text).toContain("acl_revision");
    const [orgId, spaceId] = params;
    if (orgId !== ORG) throw new Error("sync lost its org predicate");
    if (typeof spaceId !== "number") throw new Error("sync lost its space predicate");
    const viaPages = text.includes("kb_pages");
    syncedTables.push(viaPages ? "kb_pages" : "kb_articles");
    for (const chunk of store.chunks) {
      if (viaPages && chunk.pageId !== null) {
        const page = store.pages.get(chunk.pageId);
        if (page !== undefined && page.spaceId === spaceId) chunk.aclRevision = page.aclRevision;
      }
      if (!viaPages && chunk.articleId !== null) {
        const article = store.articles.get(chunk.articleId);
        if (article !== undefined && article.spaceId === spaceId)
          chunk.aclRevision = article.aclRevision;
      }
    }
    return [];
  });

  return {
    db: { update, execute, query: { kbSpaces: { findFirst: jest.fn() } } },
    bumpedTables,
    syncedTables,
  };
}

function makeIndexing(db: unknown): KbIndexingService {
  const embeddings = {
    isEmbeddingConfigured: jest.fn().mockReturnValue(false),
    embedQueryWithCredit: jest.fn(),
    embedBatchWithCredit: jest.fn(),
  };
  const checkpoint = {
    loadCheckpoints: jest.fn().mockResolvedValue(new Map()),
    saveCheckpoints: jest.fn().mockResolvedValue(undefined),
    clearCheckpoints: jest.fn().mockResolvedValue(undefined),
  };
  return new KbIndexingService(db as never, embeddings as never, checkpoint as never);
}

function makeSpaces(db: unknown, indexing: KbIndexingService) {
  const access = { invalidateAccessibleSpaceIds: jest.fn().mockResolvedValue(undefined) };
  return {
    service: new KbSpacesService(db as never, access as never, indexing, {
      visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
    } as never),
    access,
  };
}

describe("KB retrieval model mirrors the real acl_revision fence", () => {
  it("the harness reports content as unfindable the moment a chunk revision trails its parent", () => {
    const store = new KbStore();
    store.seed();
    expect(store.searchablePageIds()).toContain(PAGE);

    const page = store.pages.get(PAGE);
    if (page === undefined) throw new Error("seed failed");
    page.aclRevision += 1;

    expect(store.searchablePageIds()).not.toContain(PAGE);
  });
});

describe("KbSpacesService.update — a space-property ACL change keeps content searchable", () => {
  it("content in the space is findable before the change, and still findable after it", async () => {
    const store = new KbStore();
    store.seed();
    const { db, bumpedTables, syncedTables } = makeDb(store);
    const indexing = makeIndexing(db);
    const { service, access } = makeSpaces(db, indexing);

    expect(store.searchablePageIds()).toEqual([PAGE, OTHER_PAGE]);
    expect(store.searchableArticleIds()).toEqual([ARTICLE]);

    await service.update(ORG, SPACE, { audience: "internal" });

    expect(store.searchablePageIds()).toContain(PAGE);
    expect(store.searchableArticleIds()).toContain(ARTICLE);
    expect(bumpedTables.sort()).toEqual(["kb_articles", "kb_pages"]);
    expect(syncedTables.sort()).toEqual(["kb_articles", "kb_pages"]);
    expect(access.invalidateAccessibleSpaceIds).toHaveBeenCalledWith(ORG);
  });

  it("flipping isPublicHelpCenter is an ACL change too and also keeps content searchable", async () => {
    const store = new KbStore();
    store.seed();
    const { db } = makeDb(store);
    const indexing = makeIndexing(db);
    const { service } = makeSpaces(db, indexing);

    await service.update(ORG, SPACE, { isPublicHelpCenter: true });

    expect(store.searchablePageIds()).toContain(PAGE);
    expect(store.searchableArticleIds()).toContain(ARTICLE);
  });

  it("a non-ACL property change neither bumps nor desynchronises anything", async () => {
    const store = new KbStore();
    store.seed();
    const { db, bumpedTables, syncedTables } = makeDb(store);
    const indexing = makeIndexing(db);
    const { service } = makeSpaces(db, indexing);

    await service.update(ORG, SPACE, { description: "new blurb" });

    expect(bumpedTables).toEqual([]);
    expect(syncedTables).toEqual([]);
    expect(store.searchablePageIds()).toContain(PAGE);
  });

  it("content in a sibling space is untouched by the change", async () => {
    const store = new KbStore();
    store.seed();
    const { db } = makeDb(store);
    const indexing = makeIndexing(db);
    const { service } = makeSpaces(db, indexing);

    await service.update(ORG, SPACE, { audience: "internal" });

    expect(store.searchablePageIds()).toContain(OTHER_PAGE);
    expect(store.pages.get(OTHER_PAGE)?.aclRevision).toBe(1);
  });

  it("BITE — with the chunk sync suppressed, the same change deletes the space from search permanently", async () => {
    const store = new KbStore();
    store.seed();
    const { db } = makeDb(store);
    const indexing = makeIndexing(db);
    jest.spyOn(indexing, "syncAclRevisionForSpace").mockResolvedValue(undefined);
    const { service } = makeSpaces(db, indexing);

    expect(store.searchablePageIds()).toContain(PAGE);

    await service.update(ORG, SPACE, { audience: "internal" });

    expect(store.searchablePageIds()).not.toContain(PAGE);
    expect(store.searchableArticleIds()).not.toContain(ARTICLE);

    await service.update(ORG, SPACE, { description: "an unrelated later edit" });

    expect(store.searchablePageIds()).not.toContain(PAGE);
  });
});

describe("only KbIndexingService may bump a space-wide acl_revision", () => {
  const kbRoot = join(__dirname, "..");

  it.each([
    ["wiki/kb-spaces.service.ts"],
    ["wiki/kb-members.service.ts"],
  ])("%s does not bump acl_revision itself", (relative) => {
    const source = readFileSync(join(kbRoot, relative), "utf8");
    expect(source).not.toContain("acl_revision + 1");
    expect(source).toContain("bumpSpaceAclRevision");
  });

  it("KbIndexingService.bumpSpaceAclRevision always reaches the chunk sync", () => {
    const source = readFileSync(join(kbRoot, "retrieval/kb-indexing.service.ts"), "utf8");
    const body = source.slice(
      source.indexOf("async bumpSpaceAclRevision"),
      source.indexOf("async syncAclRevisionForSpace"),
    );
    expect(body).toContain("acl_revision + 1");
    expect(body).toContain("syncAclRevisionForSpace");
    expect(body).toContain("registerAfterCommit");
  });
});
