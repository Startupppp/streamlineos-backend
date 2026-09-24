import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import { KbService } from "./kb.service";

const dialect = new PgDialect();

const ORG = "org-help-centre";
const SLUG = "reset-your-password";

const PUBLISHED_SUPPORT_ARTICLE = {
  id: 7,
  categoryId: 3,
  title: "Reset your password",
  slug: SLUG,
  excerpt: "How to get back in",
  content: "Open the sign-in page and choose Forgot password.",
  categoryName: "Account",
  categorySlug: "account",
  views: 41,
  helpfulCount: 5,
  notHelpfulCount: 1,
  tags: ["account"],
  seoTitle: null,
  seoDescription: null,
  publishedAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-02-01T00:00:00.000Z"),
};

interface Chain extends PromiseLike<unknown[]> {
  from: jest.Mock;
  where: jest.Mock;
  innerJoin: jest.Mock;
  leftJoin: jest.Mock;
  orderBy: jest.Mock;
  limit: jest.Mock;
}

function makeChain(rows: unknown[], wheres: SQL[]): Chain {
  const chain = {} as Chain;
  chain.from = jest.fn(() => chain);
  chain.innerJoin = jest.fn(() => chain);
  chain.leftJoin = jest.fn(() => chain);
  chain.orderBy = jest.fn(() => chain);
  chain.limit = jest.fn(() => chain);
  chain.where = jest.fn((condition: SQL) => {
    wheres.push(condition);
    return chain;
  });
  chain.then = (resolve, reject) =>
    Promise.resolve(rows).then(resolve ?? undefined, reject ?? undefined);
  return chain;
}

function noopWrite() {
  return { set: jest.fn(() => ({ where: jest.fn().mockResolvedValue([]) })) };
}

interface Capture {
  wheres: SQL[];
  projections: unknown[];
}

function listHarness(rows: unknown[]) {
  const capture: Capture = { wheres: [], projections: [] };
  const categories = makeChain([], []);
  const articles = makeChain(rows, capture.wheres);
  let call = 0;
  const db = {
    select: jest.fn((projection: unknown) => {
      call += 1;
      if (call === 1) return categories;
      capture.projections.push(projection);
      return articles;
    }),
  } as unknown as Db;
  return { db, capture };
}

function articleHarness(rows: unknown[]) {
  const capture: Capture = { wheres: [], projections: [] };
  const chain = makeChain(rows, capture.wheres);
  const db = {
    select: jest.fn((projection: unknown) => {
      capture.projections.push(projection);
      return chain;
    }),
    update: jest.fn(noopWrite),
  } as unknown as Db;
  return { db, capture };
}

function feedbackHarness(rows: unknown[], inserted: { id: number }[]) {
  const capture: Capture = { wheres: [], projections: [] };
  const chain = makeChain(rows, capture.wheres);
  const tx = {
    insert: jest.fn(() => ({
      values: jest.fn(() => ({
        onConflictDoNothing: jest.fn(() => ({
          returning: jest.fn().mockResolvedValue(inserted),
        })),
      })),
    })),
    update: jest.fn(noopWrite),
  };
  const db = {
    select: jest.fn((projection: unknown) => {
      capture.projections.push(projection);
      return chain;
    }),
    transaction: jest.fn((run: (handle: unknown) => Promise<unknown>) => run(tx)),
  } as unknown as Db;
  return { db, capture };
}

interface Rendered {
  text: string;
  params: unknown[];
}

function render(where: SQL | undefined): Rendered {
  if (where === undefined)
    throw new Error("a public help-centre read issued no WHERE clause at all");
  const query = dialect.sqlToQuery(where);
  return { text: query.sql, params: query.params };
}

function boundValue(rendered: Rendered, column: string): unknown {
  const match = new RegExp(`"${column}"\\s*=\\s*\\$(\\d+)`).exec(rendered.text);
  if (match === null)
    throw new Error(`no equality predicate on ${column} in: ${rendered.text}`);
  return rendered.params[Number(match[1]) - 1];
}

function columnName(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const name: unknown = Reflect.get(value, "name");
  return typeof name === "string" ? name : null;
}

function projectionKeys(projection: unknown): string[] {
  if (typeof projection !== "object" || projection === null) return [];
  return Object.keys(projection);
}

function projectionField(projection: unknown, key: string): unknown {
  if (typeof projection !== "object" || projection === null) return null;
  return Reflect.get(projection, key);
}

function selectedColumns(projection: unknown): string[] {
  if (typeof projection !== "object" || projection === null) return [];
  return Object.values(projection)
    .map(columnName)
    .filter((name): name is string => name !== null);
}

const INTERNAL_PAGE_COLUMNS = [
  "public_token",
  "public_token_hash",
  "public_slug",
  "fts",
  "content",
  "project_id",
  "external_id",
  "external_source",
  "parent_page_id",
  "space_id",
  "acl_revision",
  "content_revision",
  "created_by_id",
  "created_by_membership_id",
  "last_edited_by_id",
  "last_edited_by_membership_id",
  "deleted_at",
  "deleted_by_id",
  "deleted_by_membership_id",
  "owner_user_id",
  "owner_membership_id",
  "verified_by_id",
  "verified_by_membership_id",
  "trust_state",
  "verified_until",
  "next_review_at",
  "is_locked",
  "sort_order",
  "source_article_id",
  "visibility",
  "content_type",
  "status",
  "icon",
  "cover_image",
];

async function listPredicate(): Promise<Rendered> {
  const { db, capture } = listHarness([]);
  await new KbService(db).list({ org: ORG, pageSize: 10 });
  return render(capture.wheres[0]);
}

async function articlePredicate(): Promise<Rendered> {
  const { db, capture } = articleHarness([PUBLISHED_SUPPORT_ARTICLE]);
  await new KbService(db).getArticle(SLUG, ORG);
  return render(capture.wheres[0]);
}

async function feedbackPredicate(): Promise<Rendered> {
  const { db, capture } = feedbackHarness([{ id: 7 }], [{ id: 1 }]);
  await new KbService(db).submitFeedback(SLUG, ORG, { helpful: true });
  return render(capture.wheres[0]);
}

const SURFACES: [string, () => Promise<Rendered>][] = [
  ["GET /public/kb", listPredicate],
  ["GET /public/kb/:slug", articlePredicate],
  ["POST /public/kb/:slug/feedback", feedbackPredicate],
];

describe("the predicate reader itself", () => {
  it("throws when the column it is asked about is absent, so every exclusion assertion below fails loudly instead of vacuously", async () => {
    const rendered = await listPredicate();
    expect(() => boundValue(rendered, "last_verified_at")).toThrow(
      "no equality predicate on last_verified_at",
    );
  });
});

for (const [route, capture] of SURFACES) {
  describe(`${route} — what the anonymous reader is allowed to match in kb_pages`, () => {
    it("binds content_type to support_article, so a note-typed wiki page is not served to the open internet", async () => {
      expect(boundValue(await capture(), "content_type")).toBe(
        "support_article",
      );
    });

    it("requires kb_pages.deleted_at to be null, so a soft-deleted page stays unreachable", async () => {
      expect((await capture()).text).toContain('"kb_pages"."deleted_at" is null');
    });

    it("binds visibility to public as an equality, so an org-visible page is excluded", async () => {
      expect(boundValue(await capture(), "visibility")).toBe("public");
    });

    it("never expresses visibility as a deny-list, because private is a value kb_articles never had and a negation would admit it", async () => {
      const { text } = await capture();
      expect(text).not.toMatch(/"visibility"\s*(<>|!=)/);
      expect(text).not.toMatch(/"visibility"\s+not\s+in/i);
      expect(text).not.toContain("internal");
      expect(text).not.toContain("private");
    });

    it("binds status to published, so a draft or archived article stays unreachable", async () => {
      expect(boundValue(await capture(), "status")).toBe("published");
    });

    it("binds org_id to the requested tenant", async () => {
      expect(boundValue(await capture(), "org_id")).toBe(ORG);
    });

    it("keeps the space fence, so an internal-audience space is excluded", async () => {
      const { text } = await capture();
      expect(text).toContain('"kb_spaces"."audience" in');
      expect(text).toContain('"kb_spaces"."deleted_at" is null');
    });
  });
}

describe("public help centre — a genuine published support_article is still served", () => {
  it("returns the article row from the list", async () => {
    const { db } = listHarness([PUBLISHED_SUPPORT_ARTICLE]);
    const result = await new KbService(db).list({ org: ORG, pageSize: 10 });
    expect(result.articles).toHaveLength(1);
    expect(result.articles[0]).toMatchObject({ slug: SLUG });
  });

  it("returns the article detail and counts the view", async () => {
    const { db } = articleHarness([PUBLISHED_SUPPORT_ARTICLE]);
    const article = await new KbService(db).getArticle(SLUG, ORG);
    expect(article.slug).toBe(SLUG);
    expect(article.views).toBe(42);
  });

  it("records feedback against the article", async () => {
    const { db } = feedbackHarness([{ id: 7 }], [{ id: 1 }]);
    const result = await new KbService(db).submitFeedback(SLUG, ORG, {
      helpful: true,
    });
    expect(result).toEqual({ success: true, recorded: true });
  });

  it("404s when the scoped read matches nothing, rather than serving a row the predicate rejected", async () => {
    const { db } = articleHarness([]);
    await expect(new KbService(db).getArticle(SLUG, ORG)).rejects.toThrow(
      "Article not found",
    );
  });
});

describe("public help centre projections — kb_pages carries internal columns kb_articles never had", () => {
  it("selects exactly the list contract fields", async () => {
    const { db, capture } = listHarness([]);
    await new KbService(db).list({ org: ORG, pageSize: 10 });
    expect(projectionKeys(capture.projections[0])).toEqual([
      "id",
      "categoryId",
      "title",
      "slug",
      "excerpt",
      "views",
      "helpfulCount",
      "notHelpfulCount",
      "tags",
      "publishedAt",
    ]);
  });

  it("selects exactly the article contract fields", async () => {
    const { db, capture } = articleHarness([PUBLISHED_SUPPORT_ARTICLE]);
    await new KbService(db).getArticle(SLUG, ORG);
    expect(projectionKeys(capture.projections[0])).toEqual([
      "id",
      "title",
      "slug",
      "excerpt",
      "content",
      "categoryId",
      "categoryName",
      "categorySlug",
      "views",
      "helpfulCount",
      "notHelpfulCount",
      "tags",
      "seoTitle",
      "seoDescription",
      "publishedAt",
      "updatedAt",
    ]);
  });

  it("maps the wire field content to content_text, never to the jsonb content column", async () => {
    const { db, capture } = articleHarness([PUBLISHED_SUPPORT_ARTICLE]);
    await new KbService(db).getArticle(SLUG, ORG);
    expect(columnName(projectionField(capture.projections[0], "content"))).toBe(
      "content_text",
    );
  });

  it("selects only the article id when resolving a feedback target", async () => {
    const { db, capture } = feedbackHarness([{ id: 7 }], [{ id: 1 }]);
    await new KbService(db).submitFeedback(SLUG, ORG, { helpful: true });
    expect(projectionKeys(capture.projections[0])).toEqual(["id"]);
  });

  it("hydrates no internal kb_pages column on the list", async () => {
    const { db, capture } = listHarness([PUBLISHED_SUPPORT_ARTICLE]);
    await new KbService(db).list({ org: ORG, pageSize: 10 });
    const columns = selectedColumns(capture.projections[0]);
    expect(columns).toContain("title");
    for (const internal of INTERNAL_PAGE_COLUMNS)
      expect(columns).not.toContain(internal);
  });

  it("hydrates no internal kb_pages column on the article detail", async () => {
    const { db, capture } = articleHarness([PUBLISHED_SUPPORT_ARTICLE]);
    await new KbService(db).getArticle(SLUG, ORG);
    const columns = selectedColumns(capture.projections[0]);
    expect(columns).toContain("content_text");
    for (const internal of INTERNAL_PAGE_COLUMNS)
      expect(columns).not.toContain(internal);
  });
});
