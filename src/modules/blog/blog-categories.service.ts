import { Inject, Injectable } from "@nestjs/common";
import { and, asc, count, eq, isNull } from "drizzle-orm";
import { blogCategories, blogPosts } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { publishedPostPredicate } from "./blog-public.projection";

const CATEGORY_CAP = 100;

/** Public category reads. Counts are of published posts only, under the shared predicate. */
@Injectable()
export class BlogCategoriesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getCategories() {
    const rows = await this.db
      .select({
        name: blogCategories.name,
        slug: blogCategories.slug,
        color: blogCategories.color,
        description: blogCategories.description,
        count: count(blogPosts.id),
      })
      .from(blogCategories)
      .leftJoin(blogPosts, and(eq(blogPosts.categoryId, blogCategories.id), publishedPostPredicate()))
      .where(isNull(blogCategories.archivedAt))
      .groupBy(blogCategories.id)
      .orderBy(asc(blogCategories.name))
      .limit(CATEGORY_CAP);
    return rows.map((r) => ({ ...r, count: Number(r.count) }));
  }

  async getCategory(slug: string) {
    const [row] = await this.db
      .select({
        name: blogCategories.name,
        slug: blogCategories.slug,
        color: blogCategories.color,
        description: blogCategories.description,
        seoTitle: blogCategories.seoTitle,
        seoDescription: blogCategories.seoDescription,
        count: count(blogPosts.id),
      })
      .from(blogCategories)
      .leftJoin(blogPosts, and(eq(blogPosts.categoryId, blogCategories.id), publishedPostPredicate()))
      .where(and(eq(blogCategories.slug, slug), isNull(blogCategories.archivedAt)))
      .groupBy(blogCategories.id)
      .limit(1);
    return row ? { ...row, count: Number(row.count) } : null;
  }
}
