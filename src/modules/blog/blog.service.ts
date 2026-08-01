import { Inject, Injectable } from "@nestjs/common";
import { and, asc, count, desc, eq, gt, lt, ne, sql } from "drizzle-orm";
import { blogCategories, blogPosts } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import { calcReadingTime, slugify } from "./blog-utils";
import type {
  CategoryCreateInput,
  CategoryUpdateInput,
  FeedInput,
  PostCreateInput,
  PostUpdateInput,
} from "./dto/blog.schemas";

const POST_WITH = { category: true, author: true } as const;
const ADMIN_POSTS_CACHE_KEY = "blog:admin:posts";
const ADMIN_POSTS_CACHE_PATTERN = "blog:admin:posts*";

@Injectable()
export class BlogService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  listAdminPosts() {
    return this.cache.cached(
      ADMIN_POSTS_CACHE_KEY,
      () =>
        this.db.query.blogPosts.findMany({
          with: POST_WITH,
          orderBy: [desc(blogPosts.updatedAt)],
        }),
      CACHE_TTL.MEDIUM,
    );
  }

  getAdminPostById(id: string) {
    return this.db.query.blogPosts.findFirst({
      where: eq(blogPosts.id, id),
      with: POST_WITH,
    });
  }

  async createPost(input: PostCreateInput) {
    const slug = await this.ensureUniqueSlug(input.slug || input.title);

    const companyAuthor = await this.db.query.blogAuthors.findFirst({
      columns: { id: true },
    });

    const [created] = await this.db
      .insert(blogPosts)
      .values({
        title: input.title,
        slug,
        excerpt: input.excerpt,
        content: input.content,
        contentJson: input.contentJson ?? null,
        coverImage: input.coverImage,
        categoryId: input.categoryId ?? null,
        authorId: input.authorId ?? companyAuthor?.id ?? null,
        status: input.status,
        isFeatured: input.isFeatured,
        readingTime: calcReadingTime(input.content),
        metaTitle: input.metaTitle ?? null,
        metaDescription: input.metaDescription ?? null,
        tags: input.tags,
        publishedAt: input.status === "published" ? new Date() : null,
      })
      .returning();

    await this.cache.invalidatePattern(ADMIN_POSTS_CACHE_PATTERN);
    return created;
  }

  async updatePost(id: string, input: PostUpdateInput) {
    const existing = await this.db.query.blogPosts.findFirst({
      where: eq(blogPosts.id, id),
    });
    if (!existing) return null;

    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (input.title !== undefined) updates.title = input.title;
    if (input.excerpt !== undefined) updates.excerpt = input.excerpt;
    if (input.content !== undefined) {
      updates.content = input.content;
      updates.readingTime = calcReadingTime(input.content);
    }
    if (input.contentJson !== undefined) updates.contentJson = input.contentJson;
    if (input.coverImage !== undefined) updates.coverImage = input.coverImage;
    if (input.categoryId !== undefined) updates.categoryId = input.categoryId;
    if (input.authorId !== undefined) updates.authorId = input.authorId;
    if (input.isFeatured !== undefined) updates.isFeatured = input.isFeatured;
    if (input.tags !== undefined) updates.tags = input.tags;
    if (input.metaTitle !== undefined) updates.metaTitle = input.metaTitle;
    if (input.metaDescription !== undefined)
      updates.metaDescription = input.metaDescription;

    if (input.slug) {
      updates.slug = await this.ensureUniqueSlug(input.slug, id);
    } else if (input.title !== undefined && input.title !== existing.title) {
      updates.slug = await this.ensureUniqueSlug(input.title, id);
    }

    if (input.status !== undefined) {
      updates.status = input.status;
      if (input.status === "published" && !existing.publishedAt) {
        updates.publishedAt = new Date();
      }
    }

    const [updated] = await this.db
      .update(blogPosts)
      .set(updates)
      .where(eq(blogPosts.id, id))
      .returning();

    await this.cache.invalidatePattern(ADMIN_POSTS_CACHE_PATTERN);
    return updated;
  }

  async deletePost(id: string) {
    const [deleted] = await this.db
      .delete(blogPosts)
      .where(eq(blogPosts.id, id))
      .returning();
    if (!deleted) return null;
    await this.cache.invalidatePattern(ADMIN_POSTS_CACHE_PATTERN);
    return { success: true };
  }

  async getCategories() {
    const rows = await this.db
      .select({
        id: blogCategories.id,
        name: blogCategories.name,
        slug: blogCategories.slug,
        color: blogCategories.color,
        description: blogCategories.description,
        count: count(blogPosts.id),
      })
      .from(blogCategories)
      .leftJoin(
        blogPosts,
        and(
          eq(blogPosts.categoryId, blogCategories.id),
          eq(blogPosts.status, "published"),
        ),
      )
      .groupBy(blogCategories.id)
      .orderBy(asc(blogCategories.name));

    return rows.map((r) => ({ ...r, count: Number(r.count) }));
  }

  async createCategory(input: CategoryCreateInput) {
    const slug = slugify(input.name);

    const existing = await this.db.query.blogCategories.findFirst({
      where: eq(blogCategories.slug, slug),
    });
    if (existing) return { error: "duplicate" as const };

    const [created] = await this.db
      .insert(blogCategories)
      .values({
        name: input.name,
        slug,
        description: input.description ?? null,
        color: input.color ?? null,
      })
      .returning();

    return created;
  }

  async updateCategory(id: string, input: CategoryUpdateInput) {
    const updates: Record<string, unknown> = {};
    if (input.name !== undefined) {
      updates.name = input.name;
      updates.slug = slugify(input.name);
    }
    if (input.description !== undefined) updates.description = input.description;
    if (input.color !== undefined) updates.color = input.color;

    const [updated] = await this.db
      .update(blogCategories)
      .set(updates)
      .where(eq(blogCategories.id, id))
      .returning();

    if (!updated) return null;
    return updated;
  }

  async deleteCategory(id: string) {
    const [deleted] = await this.db
      .delete(blogCategories)
      .where(eq(blogCategories.id, id))
      .returning();
    if (!deleted) return null;
    return { success: true };
  }

  getPublishedPostBySlug(slug: string) {
    return this.db.query.blogPosts.findFirst({
      where: and(eq(blogPosts.slug, slug), eq(blogPosts.status, "published")),
      with: POST_WITH,
    });
  }

  async getAdjacentPosts(slug: string) {
    const post = await this.db.query.blogPosts.findFirst({
      where: and(eq(blogPosts.slug, slug), eq(blogPosts.status, "published")),
      columns: { publishedAt: true },
    });

    if (!post?.publishedAt) return { prev: null, next: null };

    const [prev] = await this.db.query.blogPosts.findMany({
      where: and(
        eq(blogPosts.status, "published"),
        lt(blogPosts.publishedAt, post.publishedAt),
      ),
      orderBy: [desc(blogPosts.publishedAt)],
      limit: 1,
      columns: { slug: true, title: true },
    });

    const [next] = await this.db.query.blogPosts.findMany({
      where: and(
        eq(blogPosts.status, "published"),
        gt(blogPosts.publishedAt, post.publishedAt),
      ),
      orderBy: [asc(blogPosts.publishedAt)],
      limit: 1,
      columns: { slug: true, title: true },
    });

    return { prev: prev ?? null, next: next ?? null };
  }

  async getPublishedPosts(input: FeedInput) {
    const limit = Math.min(input.limit ?? 9, 50);

    const conditions = [eq(blogPosts.status, "published")];

    if (input.featured === true) {
      conditions.push(eq(blogPosts.isFeatured, true));
    }

    if (input.category) {
      const category = await this.db.query.blogCategories.findFirst({
        where: eq(blogCategories.slug, input.category),
      });
      if (!category) return { posts: [], nextCursor: null, hasMore: false };
      conditions.push(eq(blogPosts.categoryId, category.id));
    }

    if (input.tag) {
      conditions.push(sql`${input.tag} = ANY(${blogPosts.tags})`);
    }

    if (input.search) {
      const term = `%${input.search}%`;
      conditions.push(
        sql`(${blogPosts.title} ILIKE ${term} OR ${blogPosts.excerpt} ILIKE ${term})`,
      );
    }

    if (input.cursor) {
      const cursorDate = new Date(input.cursor);
      if (!Number.isNaN(cursorDate.getTime())) {
        conditions.push(lt(blogPosts.publishedAt, cursorDate));
      }
    }

    const rows = await this.db.query.blogPosts.findMany({
      where: and(...conditions),
      with: POST_WITH,
      orderBy: [desc(blogPosts.publishedAt)],
      limit: limit + 1,
    });

    const hasMore = rows.length > limit;
    const posts = hasMore ? rows.slice(0, limit) : rows;
    const last = posts[posts.length - 1];
    const nextCursor =
      hasMore && last?.publishedAt ? last.publishedAt.toISOString() : null;

    return { posts, nextCursor, hasMore };
  }

  private async ensureUniqueSlug(
    base: string,
    excludeId?: string,
  ): Promise<string> {
    const root = slugify(base) || "post";
    let candidate = root;
    let n = 2;

    for (;;) {
      const clash = await this.db.query.blogPosts.findFirst({
        where: excludeId
          ? and(eq(blogPosts.slug, candidate), ne(blogPosts.id, excludeId))
          : eq(blogPosts.slug, candidate),
        columns: { id: true },
      });
      if (!clash) return candidate;
      candidate = `${root}-${n++}`;
    }
  }
}

export type CreateCategoryResult = Awaited<
  ReturnType<BlogService["createCategory"]>
>;
