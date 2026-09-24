import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { kbPages, kbPageTranslations } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { isUniqueViolation } from "../../../common/db/postgres-error";
import { supportArticlePredicate } from "../help-centre/kb-article-page-scope";
import type { UpsertTranslationInput } from "./dto/kb-translations.schemas";

type TranslationSelect = typeof kbPageTranslations.$inferSelect;

export type TranslationRow = Omit<TranslationSelect, "pageId"> & {
  articleId: TranslationSelect["pageId"];
};

const translationProjection = {
  id: kbPageTranslations.id,
  orgId: kbPageTranslations.orgId,
  articleId: kbPageTranslations.pageId,
  locale: kbPageTranslations.locale,
  title: kbPageTranslations.title,
  content: kbPageTranslations.content,
  contentText: kbPageTranslations.contentText,
  excerpt: kbPageTranslations.excerpt,
  status: kbPageTranslations.status,
  createdAt: kbPageTranslations.createdAt,
  updatedAt: kbPageTranslations.updatedAt,
};

@Injectable()
export class KbTranslationsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(orgId: string, articleId: number): Promise<TranslationRow[]> {
    await this.assertArticleExists(orgId, articleId);
    return this.db
      .select(translationProjection)
      .from(kbPageTranslations)
      .where(
        and(
          eq(kbPageTranslations.orgId, orgId),
          eq(kbPageTranslations.pageId, articleId),
        ),
      );
  }

  async get(
    orgId: string,
    articleId: number,
    locale: string,
  ): Promise<TranslationRow> {
    await this.assertArticleExists(orgId, articleId);
    const [row] = await this.db
      .select(translationProjection)
      .from(kbPageTranslations)
      .where(
        and(
          eq(kbPageTranslations.orgId, orgId),
          eq(kbPageTranslations.pageId, articleId),
          eq(kbPageTranslations.locale, locale),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException("Translation not found");
    return row;
  }

  async upsert(
    orgId: string,
    articleId: number,
    locale: string,
    input: UpsertTranslationInput,
  ): Promise<TranslationRow> {
    await this.assertArticleExists(orgId, articleId);
    try {
      const [row] = await this.db
        .insert(kbPageTranslations)
        .values({
          orgId,
          pageId: articleId,
          locale,
          title: input.title,
          content: input.content ?? "",
          contentText: input.contentText ?? "",
          excerpt: input.excerpt ?? null,
          status: input.status ?? "draft",
        })
        .onConflictDoUpdate({
          target: [kbPageTranslations.pageId, kbPageTranslations.locale],
          set: {
            title: input.title,
            content: input.content ?? "",
            contentText: input.contentText ?? "",
            excerpt: input.excerpt ?? null,
            ...(input.status ? { status: input.status } : {}),
            updatedAt: new Date(),
          },
        })
        .returning(translationProjection);
      return row;
    } catch (err) {
      if (isUniqueViolation(err))
        throw new ConflictException("This translation already exists");
      throw err;
    }
  }

  async remove(
    orgId: string,
    articleId: number,
    locale: string,
  ): Promise<{ success: boolean }> {
    await this.assertArticleExists(orgId, articleId);
    const [deleted] = await this.db
      .delete(kbPageTranslations)
      .where(
        and(
          eq(kbPageTranslations.orgId, orgId),
          eq(kbPageTranslations.pageId, articleId),
          eq(kbPageTranslations.locale, locale),
        ),
      )
      .returning({ id: kbPageTranslations.id });
    if (!deleted) throw new NotFoundException("Translation not found");
    return { success: true };
  }

  private async assertArticleExists(
    orgId: string,
    articleId: number,
  ): Promise<void> {
    const article = await this.db.query.kbPages.findFirst({
      where: and(
        eq(kbPages.id, articleId),
        eq(kbPages.orgId, orgId),
        supportArticlePredicate(),
      ),
      columns: { id: true },
    });
    if (!article) throw new NotFoundException("Article not found");
  }
}
