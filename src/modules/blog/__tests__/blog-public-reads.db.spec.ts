/**
 * The publication predicate, proven against real rows.
 *
 * Every public blog surface — list, detail, related, search, sitemap, author, category — must agree
 * on what is published. A mocked database cannot show that: the predicate is SQL, and a fake returns
 * whatever it is told. So each surface here reads the same seeded mix of eligible and ineligible
 * rows (draft, scheduled, future-dated, archived, soft-deleted, published-without-revision), and
 * every assertion that something is absent is paired with one that the eligible row is present.
 *
 *   BLOG_PROBE_DATABASE_URL=postgresql://… \
 *     npx jest --config jest-db.json --runInBand --testPathPattern="blog-public-reads.db"
 *
 * The database needs migration 1705. Fixtures carry a random suffix and are deleted afterwards.
 */
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../../db/schema";
import { blogAuthors, blogCategories, blogPosts, blogRedirects } from "../../../db/schema";
import { BlogService } from "../blog.service";
import { BlogDiscoveryService } from "../blog-discovery.service";
import { BlogCategoriesService } from "../blog-categories.service";

const DB_URL = process.env.BLOG_PROBE_DATABASE_URL;

jest.setTimeout(120_000);

describe("blog public reads — one publication predicate on every surface", () => {
  let client: postgres.Sql;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let blog: BlogService;
  let discovery: BlogDiscoveryService;
  let categories: BlogCategoriesService;
  const s = randomUUID().slice(0, 8);
  const slug = (name: string) => `${name}-${s}`;
  const postIds: string[] = [];
  let authorId = "";
  let categoryId = "";

  async function seedPost(name: string, opts: {
    status: "draft" | "published" | "archived";
    publishedAt?: string | null;
    withRevision?: boolean;
    archived?: boolean;
    deleted?: boolean;
    scheduled?: boolean;
    title?: string;
    tags?: string[];
  }) {
    const [post] = await db.insert(blogPosts).values({
      title: opts.title ?? `Title ${name} ${s}`,
      slug: slug(name),
      excerpt: `Excerpt ${name}`,
      content: `<p>Body of ${name} mentions quasarbanana${s}</p>`,
      coverImage: "",
      status: opts.status,
      categoryId,
      authorId,
      tags: opts.tags ?? [],
      searchText: `Body of ${name} mentions quasarbanana${s}`,
      publishedAt: opts.publishedAt === undefined ? null : opts.publishedAt === null ? null : new Date(opts.publishedAt),
      archivedAt: opts.archived ? new Date() : null,
      deletedAt: opts.deleted ? new Date() : null,
    }).returning({ id: blogPosts.id });
    if (!post) throw new Error("seed failed");
    postIds.push(post.id);
    const [rev] = await client<{ id: string }[]>`
      INSERT INTO blog_post_revisions (post_id, seq, doc, html, title, slug)
      VALUES (${post.id}, 1, '{"type":"doc","content":[]}'::jsonb, '<p></p>', ${name}, ${slug(name)})
      RETURNING id`;
    if (!rev) throw new Error("seed failed");
    await client`
      UPDATE blog_posts SET
        working_revision_id = ${rev.id},
        published_revision_id = ${opts.withRevision === false ? null : opts.status === "draft" && !opts.scheduled ? null : rev.id},
        scheduled_revision_id = ${opts.scheduled ? rev.id : null},
        scheduled_for = ${opts.scheduled ? client`now() + interval '1 day'` : null}
      WHERE id = ${post.id}`;
    return post.id;
  }

  beforeAll(async () => {
    if (!DB_URL) throw new Error("blog-public-reads.db.spec.ts requires BLOG_PROBE_DATABASE_URL");
    client = postgres(DB_URL, { max: 2 });
    db = drizzle(client, { schema });
    blog = new BlogService(db);
    discovery = new BlogDiscoveryService(db);
    categories = new BlogCategoriesService(db);

    const [author] = await db.insert(blogAuthors)
      .values({ name: `Author ${s}`, slug: slug("author"), email: `author-${s}@example.test`, bio: "Bio" })
      .returning({ id: blogAuthors.id });
    const [category] = await db.insert(blogCategories)
      .values({ name: `Category ${s}`, slug: slug("category") })
      .returning({ id: blogCategories.id });
    if (!author || !category) throw new Error("seed failed");
    authorId = author.id;
    categoryId = category.id;

    await seedPost("live", { status: "published", publishedAt: "2026-01-02T10:00:00Z", tags: ["hr"] });
    await seedPost("tie-a", { status: "published", publishedAt: "2026-01-01T10:00:00Z" });
    await seedPost("tie-b", { status: "published", publishedAt: "2026-01-01T10:00:00Z" });
    await seedPost("draft", { status: "draft" });
    await seedPost("scheduled", { status: "draft", scheduled: true });
    await seedPost("future", { status: "published", publishedAt: "2099-01-01T00:00:00Z" });
    await seedPost("archived", { status: "published", publishedAt: "2026-01-01T00:00:00Z", archived: true });
    await seedPost("deleted", { status: "published", publishedAt: "2026-01-01T00:00:00Z", deleted: true });
    await seedPost("no-revision", { status: "published", publishedAt: "2026-01-01T00:00:00Z", withRevision: false });
    await db.insert(blogRedirects).values({ sourcePath: `/blogs/${slug("old")}`, targetPath: `/blogs/${slug("live")}`, statusCode: 301 });
  });

  afterAll(async () => {
    if (!client) return;
    await db.delete(blogRedirects).where(inArray(blogRedirects.sourcePath, [`/blogs/${slug("old")}`]));
    if (postIds.length) await db.delete(blogPosts).where(inArray(blogPosts.id, postIds));
    if (authorId) await db.delete(blogAuthors).where(inArray(blogAuthors.id, [authorId]));
    if (categoryId) await db.delete(blogCategories).where(inArray(blogCategories.id, [categoryId]));
    await client.end();
  });

  const eligible = () => [slug("live"), slug("tie-a"), slug("tie-b")].sort();

  it("lists exactly the eligible posts for the category, ordered by date then id", async () => {
    const page = await blog.listPublishedPosts({ page: 1, limit: 24, category: slug("category") });
    expect(page.posts.map((p) => p.slug).sort()).toEqual(eligible());
    expect(page.total).toBe(3);
    const [first, second, third] = page.posts;
    expect(first?.slug).toBe(slug("live"));
    expect(second && third && second.id > third.id).toBe(true);
  });

  it("pages across equal timestamps without duplicating or dropping a post", async () => {
    const one = await blog.listPublishedPosts({ page: 1, limit: 2, category: slug("category") });
    const two = await blog.listPublishedPosts({ page: 2, limit: 2, category: slug("category") });
    const seen = [...one.posts, ...two.posts].map((p) => p.slug);
    expect(new Set(seen).size).toBe(3);
    expect(seen.sort()).toEqual(eligible());
  });

  it("resolves a published article and 404s every ineligible one", async () => {
    const live = await blog.getPublishedPostBySlug(slug("live"));
    expect(live?.contentHtml).toContain("quasarbanana");
    for (const name of ["draft", "scheduled", "future", "archived", "deleted", "no-revision"]) {
      expect(await blog.getPublishedPostBySlug(slug(name))).toBeNull();
    }
  });

  it("never exposes the author's email on an article", async () => {
    const live = await blog.getPublishedPostBySlug(slug("live"));
    expect(live?.author?.name).toBe(`Author ${s}`);
    expect(JSON.stringify(live)).not.toContain(`author-${s}@example.test`);
  });

  it("searches published body text only", async () => {
    const hits = await discovery.search({ q: `quasarbanana${s}`, limit: 20 });
    expect(hits.map((h) => h.slug).sort()).toEqual(eligible());
  });

  it("keeps drafts and withdrawn posts out of related posts", async () => {
    const related = await blog.getRelatedPosts(slug("live"));
    const slugs = related?.map((r) => r.slug) ?? [];
    expect(slugs).toEqual(expect.arrayContaining([slug("tie-a"), slug("tie-b")]));
    expect(slugs).not.toContain(slug("live"));
    expect(slugs.filter((x) => x.endsWith(s)).every((x) => eligible().includes(x))).toBe(true);
  });

  it("counts only eligible posts for the author and category", async () => {
    expect((await discovery.getAuthor(slug("author")))?.count).toBe(3);
    expect((await categories.getCategory(slug("category")))?.count).toBe(3);
  });

  it("lists only eligible posts in the sitemap", async () => {
    const found: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 1000; i++) {
      const page = await discovery.sitemapPosts({ cursor });
      found.push(...page.posts.map((p) => p.slug).filter((x) => x.endsWith(s)));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(found.sort()).toEqual(eligible());
  });

  it("resolves a recorded redirect and nothing for an unknown path", async () => {
    expect(await discovery.resolveRedirect(`/blogs/${slug("old")}`)).toEqual({ statusCode: 301, targetPath: `/blogs/${slug("live")}` });
    expect(await discovery.resolveRedirect(`/blogs/${slug("never")}`)).toBeNull();
  });
});
