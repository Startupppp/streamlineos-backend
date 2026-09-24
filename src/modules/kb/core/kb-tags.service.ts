import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { kbPageTags, kbPages, kbTags } from "../../../db/schema";
import { isUniqueViolation } from "../../../common/db/postgres-error";
import { supportArticlePredicate } from "../help-centre/kb-article-page-scope";
import { kbSlugify } from "./kb.util";
import type {
  CreateTagInput,
  SetArticleTagsInput,
} from "./dto/kb-tags.schemas";

type TagRow = typeof kbTags.$inferSelect;

type ArticleTagRow = Pick<
  TagRow,
  "id" | "orgId" | "name" | "slug" | "createdAt"
>;

@Injectable()
export class KbTagsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  list(orgId: string): Promise<TagRow[]> {
    return this.db
      .select()
      .from(kbTags)
      .where(eq(kbTags.orgId, orgId))
      .orderBy(asc(kbTags.name))
      .limit(500);
  }

  async create(orgId: string, input: CreateTagInput): Promise<TagRow> {
    const slug = kbSlugify(input.name);
    const existing = await this.db.query.kbTags.findFirst({
      where: and(eq(kbTags.orgId, orgId), eq(kbTags.slug, slug)),
      columns: { id: true },
    });
    if (existing)
      throw new ConflictException("A tag with this name already exists");
    try {
      const [tag] = await this.db
        .insert(kbTags)
        .values({ orgId, name: input.name, slug })
        .returning();
      return tag;
    } catch (err) {
      if (isUniqueViolation(err))
        throw new ConflictException("A tag with this name already exists");
      throw err;
    }
  }

  async remove(orgId: string, tagId: number): Promise<{ success: boolean }> {
    const [deleted] = await this.db
      .delete(kbTags)
      .where(and(eq(kbTags.id, tagId), eq(kbTags.orgId, orgId)))
      .returning({ id: kbTags.id });
    if (!deleted) throw new NotFoundException("Tag not found");
    return { success: true };
  }

  async getArticleTags(orgId: string, articleId: number): Promise<ArticleTagRow[]> {
    const article = await this.db.query.kbPages.findFirst({
      columns: { id: true },
      where: and(
        eq(kbPages.id, articleId),
        eq(kbPages.orgId, orgId),
        supportArticlePredicate(),
      ),
    });
    if (!article) throw new NotFoundException("Article not found");
    return this.db
      .select({
        id: kbTags.id,
        orgId: kbTags.orgId,
        name: kbTags.name,
        slug: kbTags.slug,
        createdAt: kbTags.createdAt,
      })
      .from(kbTags)
      .innerJoin(kbPageTags, eq(kbPageTags.tagId, kbTags.id))
      .where(and(eq(kbPageTags.pageId, articleId), eq(kbTags.orgId, orgId)))
      .orderBy(asc(kbTags.name))
      .limit(50);
  }

  async setArticleTags(
    orgId: string,
    articleId: number,
    input: SetArticleTagsInput,
  ): Promise<ArticleTagRow[]> {
    const requestedTagIds = [...new Set(input.tagIds)];
    return this.db.transaction(async (tx) => {
      const [article] = await tx
        .select({ id: kbPages.id })
        .from(kbPages)
        .where(
          and(
            eq(kbPages.id, articleId),
            eq(kbPages.orgId, orgId),
            ne(kbPages.status, "archived"),
            supportArticlePredicate(),
          ),
        )
        .limit(1);
      if (!article) throw new NotFoundException("Article not found");

      const resolvedTags: ArticleTagRow[] =
        requestedTagIds.length > 0
          ? await tx
              .select({
                id: kbTags.id,
                orgId: kbTags.orgId,
                name: kbTags.name,
                slug: kbTags.slug,
                createdAt: kbTags.createdAt,
              })
              .from(kbTags)
              .where(
                and(eq(kbTags.orgId, orgId), inArray(kbTags.id, requestedTagIds)),
              )
              .orderBy(asc(kbTags.name))
              .limit(requestedTagIds.length)
          : [];
      if (resolvedTags.length !== requestedTagIds.length)
        throw new NotFoundException("One or more tag IDs not found in this organization");

      await tx
        .delete(kbPageTags)
        .where(
          and(eq(kbPageTags.orgId, orgId), eq(kbPageTags.pageId, articleId)),
        );

      if (requestedTagIds.length > 0) {
        try {
          await tx.insert(kbPageTags).values(
            requestedTagIds.map((tagId) => ({
              orgId,
              pageId: articleId,
              tagId,
            })),
          );
        } catch (err) {
          if (isUniqueViolation(err))
            throw new ConflictException(
              "The tags on this article were changed concurrently",
            );
          throw err;
        }
      }

      return resolvedTags;
    });
  }
}
