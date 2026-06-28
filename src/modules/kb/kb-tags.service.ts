import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { kbArticles, kbArticleTags, kbTags } from "../../db/schema";
import { kbSlugify } from "./kb.util";
import type { CreateTagInput, SetArticleTagsInput } from "./dto/kb-tags.schemas";

@Injectable()
export class KbTagsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  list(orgId: string) {
    return this.db
      .select()
      .from(kbTags)
      .where(eq(kbTags.orgId, orgId))
      .orderBy(asc(kbTags.name));
  }

  async create(orgId: string, input: CreateTagInput) {
    const slug = kbSlugify(input.name);
    const existing = await this.db.query.kbTags.findFirst({
      where: and(eq(kbTags.orgId, orgId), eq(kbTags.slug, slug)),
      columns: { id: true },
    });
    if (existing) throw new ConflictException("A tag with this name already exists");
    const [tag] = await this.db
      .insert(kbTags)
      .values({ orgId, name: input.name, slug })
      .returning();
    return tag;
  }

  async remove(orgId: string, tagId: number) {
    const [deleted] = await this.db
      .delete(kbTags)
      .where(and(eq(kbTags.id, tagId), eq(kbTags.orgId, orgId)))
      .returning({ id: kbTags.id });
    if (!deleted) throw new NotFoundException("Tag not found");
    return { success: true };
  }

  getArticleTags(orgId: string, articleId: number) {
    return this.db
      .select({
        id: kbTags.id,
        orgId: kbTags.orgId,
        name: kbTags.name,
        slug: kbTags.slug,
        createdAt: kbTags.createdAt,
      })
      .from(kbTags)
      .innerJoin(kbArticleTags, eq(kbArticleTags.tagId, kbTags.id))
      .where(and(eq(kbArticleTags.articleId, articleId), eq(kbTags.orgId, orgId)))
      .orderBy(asc(kbTags.name));
  }

  async setArticleTags(orgId: string, articleId: number, input: SetArticleTagsInput) {
    return this.db.transaction(async (tx) => {
      await tx.delete(kbArticleTags).where(eq(kbArticleTags.articleId, articleId));

      if (input.tagIds.length > 0) {
        await tx
          .insert(kbArticleTags)
          .values(input.tagIds.map((tagId) => ({ articleId, tagId })));
      }

      const resolvedTags =
        input.tagIds.length > 0
          ? await tx
              .select({ id: kbTags.id, orgId: kbTags.orgId, name: kbTags.name, slug: kbTags.slug, createdAt: kbTags.createdAt })
              .from(kbTags)
              .where(and(eq(kbTags.orgId, orgId), inArray(kbTags.id, input.tagIds)))
              .orderBy(asc(kbTags.name))
          : [];

      await tx
        .update(kbArticles)
        .set({ tags: resolvedTags.length > 0 ? resolvedTags.map((t) => t.name) : null })
        .where(and(eq(kbArticles.id, articleId), eq(kbArticles.orgId, orgId)));

      return resolvedTags;
    });
  }
}
