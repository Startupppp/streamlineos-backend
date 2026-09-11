import { and, asc, count, eq } from "drizzle-orm";
import { blogCategories, blogPosts } from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import { slugify } from "../blog-utils";
import type {
  CategoryCreateInput,
  CategoryUpdateInput,
} from "../dto/blog.schemas";

/**
 * The blog's category taxonomy, which is its own table with its own CRUD and
 * shares nothing with the post lifecycle: no cache namespace, no slug-collision
 * loop, no reading-time or publish-state handling. Kept out of the service so
 * that file is about posts.
 */
export interface BlogCategoryDeps {
  readonly db: Db;
}

export async function listCategories(deps: BlogCategoryDeps) {
  const rows = await deps.db
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
 * The admin projection, deliberately not `listCategories`. The public list
 * counts PUBLISHED posts only, so a category holding nothing but drafts reads
 * as empty to the person deciding whether to delete it; here every post that
 * references the category counts, and `createdAt` is carried through.
 */
export async function listAdminCategories(deps: BlogCategoryDeps) {
  const rows = await deps.db
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

export async function createCategory(
  deps: BlogCategoryDeps,
  input: CategoryCreateInput,
) {
  const slug = slugify(input.name);

  const existing = await deps.db.query.blogCategories.findFirst({
    where: eq(blogCategories.slug, slug),
  });
  if (existing) return { error: "duplicate" as const };

  const [created] = await deps.db
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

export async function updateCategory(
  deps: BlogCategoryDeps,
  id: string,
  input: CategoryUpdateInput,
) {
  const updates: Record<string, unknown> = {};
  if (input.name !== undefined) {
    updates.name = input.name;
    updates.slug = slugify(input.name);
  }
  if (input.description !== undefined) updates.description = input.description;
  if (input.color !== undefined) updates.color = input.color;

  const [updated] = await deps.db
    .update(blogCategories)
    .set(updates)
    .where(eq(blogCategories.id, id))
    .returning();

  if (!updated) return null;
  return updated;
}

export async function deleteCategory(deps: BlogCategoryDeps, id: string) {
  const [deleted] = await deps.db
    .delete(blogCategories)
    .where(eq(blogCategories.id, id))
    .returning();
  if (!deleted) return null;
  return { success: true };
}
