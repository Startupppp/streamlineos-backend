/**
 * The admin category list counts what an administrator is deciding about.
 *
 * `GET /blog/admin/categories` did not exist. `useAdminBlogCategories` called it
 * anyway, so the Categories tab 404'd into an ErrorState and the category picker
 * in the post form was empty — the create/edit/delete routes that DO exist had
 * nothing to operate on.
 *
 * The obvious repair — repoint the hook at the public `GET /blog/categories` —
 * is wrong, and this spec is what says so. That list joins `blog_posts` under
 * `status = 'published'`, so a category holding only drafts reports zero posts
 * to the person deciding whether to delete it. The admin projection joins on the
 * foreign key alone and carries `createdAt`.
 *
 * A mocked database cannot see the difference: the two queries differ only in a
 * join predicate, and a fake returns whatever it was told. So the counts here
 * come out of a real `LEFT JOIN ... GROUP BY ... count()` over real rows, in the
 * house `.db.spec.ts` style. `blog_categories` and `blog_posts` carry no
 * `org_id` — the blog is a single platform-level publication — so the fixtures
 * are suffixed and deleted in `finally`, leaving the database as it was found.
 *
 *   BLOG_DB_TESTS=1 BLOG_PROBE_DATABASE_URL=postgresql://… \
 *     npx jest --runInBand --testPathPattern="blog-admin-categories.db"
 */
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
// The namespace is what `drizzle(client, { schema })` needs to produce a value of
// type `Db`, which is `PostgresJsDatabase<typeof schema>` — the house `.db.spec.ts`
// shape. The restriction guards the legacy CRM identity tables (leads, clients,
// contacts, crmOrganizations); this file touches none of them, and the two
// projections under test read only `blog_categories` and `blog_posts`.
// eslint-disable-next-line no-restricted-imports -- namespace needed for the Db type; no CRM identity table is referenced here
import * as schema from "../../../db/schema";
import { blogCategories, blogPosts } from "../../../db/schema";
import { CacheService } from "../../../common/cache/cache.service";
import { BlogService } from "../blog.service";

const ENABLED = process.env.BLOG_DB_TESTS === "1";
const DB_URL = process.env.BLOG_PROBE_DATABASE_URL ?? process.env.APP_DATABASE_URL;
const describeDb = ENABLED && DB_URL !== undefined ? describe : describe.skip;

if (ENABLED) jest.setTimeout(120_000);

describeDb("blog admin categories — counts every post, not just published ones", () => {
  let client: postgres.Sql;
  let service: BlogService;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  const createdCategoryIds: string[] = [];

  beforeAll(() => {
    client = postgres(DB_URL ?? "", { max: 1, prepare: false, onnotice: () => undefined });
    db = drizzle(client, { schema });
    // Redis null: reads degrade to the database, which is what these two
    // projections do anyway — neither consults the cache.
    service = new BlogService(db, new CacheService(null));
  });

  afterEach(async () => {
    if (createdCategoryIds.length === 0) return;
    const ids = createdCategoryIds.splice(0, createdCategoryIds.length);
    await db.delete(blogPosts).where(inArray(blogPosts.categoryId, ids));
    await db.delete(blogCategories).where(inArray(blogCategories.id, ids));
  });

  afterAll(async () => {
    if (client) await client.end({ timeout: 5 });
  });

  async function makeCategory(suffix: string): Promise<string> {
    const [row] = await db
      .insert(blogCategories)
      .values({
        name: `Probe ${suffix}`,
        slug: `probe-${suffix}`,
        description: "drafts only",
        color: "#112233",
      })
      .returning({ id: blogCategories.id });
    if (!row) throw new Error("category insert returned no row");
    createdCategoryIds.push(row.id);
    return row.id;
  }

  it("a category holding no published post reports its posts to the admin and zero to the public", async () => {
    const suffix = randomUUID().slice(0, 8);
    const categoryId = await makeCategory(suffix);

    // Two drafts and one archived post, nothing published: the public list must
    // see zero here and the admin list three.
    for (const [index, status] of (["draft", "draft", "archived"] as const).entries()) {
      await db.insert(blogPosts).values({
        title: `Probe post ${suffix} ${index}`,
        slug: `probe-post-${suffix}-${index}`,
        excerpt: "e",
        content: "c",
        coverImage: "https://example.test/cover.png",
        categoryId,
        status,
      });
    }

    const adminRows = await service.getAdminCategories();
    const publicRows = await service.getCategories();

    const admin = adminRows.find((row) => row.id === categoryId);
    const publicRow = publicRows.find((row) => row.id === categoryId);

    // Anti-vacuity: both reads must actually have returned the probe row, or the
    // count assertions below would pass over `undefined`.
    expect(admin).toBeDefined();
    expect(publicRow).toBeDefined();

    expect(admin?.postCount).toBe(3);
    expect(publicRow?.count).toBe(0);
    expect(admin?.name).toBe(`Probe ${suffix}`);
    // The client type declares createdAt; the public projection does not carry it.
    expect(admin?.createdAt).toBeInstanceOf(Date);
  });

  it("a published post is counted by both projections", async () => {
    const suffix = randomUUID().slice(0, 8);
    const categoryId = await makeCategory(suffix);

    await db.insert(blogPosts).values({
      title: `Probe live ${suffix}`,
      slug: `probe-live-${suffix}`,
      excerpt: "e",
      content: "c",
      coverImage: "https://example.test/cover.png",
      categoryId,
      status: "published",
    });

    const admin = (await service.getAdminCategories()).find((row) => row.id === categoryId);
    const publicRow = (await service.getCategories()).find((row) => row.id === categoryId);

    expect(admin?.postCount).toBe(1);
    expect(publicRow?.count).toBe(1);
  });

  it("a category with no posts at all reports zero, not a missing row", async () => {
    const suffix = randomUUID().slice(0, 8);
    const categoryId = await makeCategory(suffix);

    const row = (await service.getAdminCategories()).find((r) => r.id === categoryId);

    expect(row).toBeDefined();
    expect(row?.postCount).toBe(0);
  });

  it("leaves no probe rows behind", async () => {
    const suffix = randomUUID().slice(0, 8);
    const categoryId = await makeCategory(suffix);
    const ids = createdCategoryIds.splice(0, createdCategoryIds.length);

    await db.delete(blogCategories).where(inArray(blogCategories.id, ids));

    const remaining = await db
      .select({ id: blogCategories.id })
      .from(blogCategories)
      .where(eq(blogCategories.id, categoryId));
    expect(remaining).toEqual([]);
  });
});
