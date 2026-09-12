import { Inject, Injectable } from "@nestjs/common";
import { and, asc, count, eq } from "drizzle-orm";
import { blogCategories, blogPosts } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { slugify } from "./blog-utils";
import type {
  CategoryCreateInput,
  CategoryUpdateInput,
} from "./dto/blog.schemas";

@Injectable()
export class BlogCategoriesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

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

  /**
   * The admin projection, deliberately not `getCategories()`. The public list
   * counts PUBLISHED posts only, so a category holding nothing but drafts reads
   * as empty to the person deciding whether to delete it; here every post that
   * references the category counts, and `createdAt` is carried through.
   */
  async getAdminCategories() {
    const rows = await this.db
      .select({
        id: blogCategories.id,
        name: blogCategories.name,
        slug: blogCategories.slug,
        description: blogCategories.description,
        color: blogCategories.color,
        createdAt: blogCategories.createdAt,
        postCount: count(blogPosts.id),
      })
      .from(blogCategories)
      .leftJoin(blogPosts, eq(blogPosts.categoryId, blogCategories.id))
      .groupBy(blogCategories.id)
      .orderBy(asc(blogCategories.name));

    return rows.map((r) => ({ ...r, postCount: Number(r.postCount) }));
  }

  async createCategory(input: CategoryCreateInput) {
    const slug = slugify(input.name);

    const existing = await this.db.query.blogCategories.findFirst({
      columns: { id: true },
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
}
