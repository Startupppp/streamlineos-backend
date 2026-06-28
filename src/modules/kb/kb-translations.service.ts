import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { kbArticleTranslations } from "../../db/schema/kb";
import { kbArticles } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { UpsertTranslationInput } from "./dto/kb-translations.schemas";

@Injectable()
export class KbTranslationsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(orgId: string, articleId: number) {
    await this.assertArticleExists(orgId, articleId);
    return this.db
      .select()
      .from(kbArticleTranslations)
      .where(
        and(
          eq(kbArticleTranslations.orgId, orgId),
          eq(kbArticleTranslations.articleId, articleId),
        ),
      );
  }

  async get(orgId: string, articleId: number, locale: string) {
    const [row] = await this.db
      .select()
      .from(kbArticleTranslations)
      .where(
        and(
          eq(kbArticleTranslations.orgId, orgId),
          eq(kbArticleTranslations.articleId, articleId),
          eq(kbArticleTranslations.locale, locale),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException("Translation not found");
    return row;
  }

  async upsert(orgId: string, articleId: number, locale: string, input: UpsertTranslationInput) {
    await this.assertArticleExists(orgId, articleId);
    const [row] = await this.db
      .insert(kbArticleTranslations)
      .values({
        orgId,
        articleId,
        locale,
        title: input.title,
        content: input.content ?? "",
        contentText: input.contentText ?? "",
        excerpt: input.excerpt ?? null,
        status: input.status ?? "draft",
      })
      .onConflictDoUpdate({
        target: [kbArticleTranslations.articleId, kbArticleTranslations.locale],
        set: {
          title: input.title,
          content: input.content ?? "",
          contentText: input.contentText ?? "",
          excerpt: input.excerpt ?? null,
          ...(input.status ? { status: input.status } : {}),
          updatedAt: new Date(),
        },
      })
      .returning();
    return row;
  }

  async remove(orgId: string, articleId: number, locale: string) {
    const [deleted] = await this.db
      .delete(kbArticleTranslations)
      .where(
        and(
          eq(kbArticleTranslations.orgId, orgId),
          eq(kbArticleTranslations.articleId, articleId),
          eq(kbArticleTranslations.locale, locale),
        ),
      )
      .returning();
    if (!deleted) throw new NotFoundException("Translation not found");
    return deleted;
  }

  private async assertArticleExists(orgId: string, articleId: number): Promise<void> {
    const article = await this.db.query.kbArticles.findFirst({
      where: and(eq(kbArticles.id, articleId), eq(kbArticles.orgId, orgId)),
      columns: { id: true },
    });
    if (!article) throw new NotFoundException("Article not found");
  }
}
