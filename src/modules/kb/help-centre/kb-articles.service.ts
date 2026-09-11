import { HttpException, HttpStatus, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { kbArticles, kbArticleFeedback } from "../../../db/schema";
import { actingMembershipId } from "../../../common/auth/principal";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { getPostgresErrorCode } from "../../../common/db/postgres-error";
import { KbAccessService } from "../core/kb-access.service";
import { KbEventsService } from "../core/kb-events.service";
import {
  emitArticleIndexEvent,
  readArticleTags,
  restoreArticleVersion,
  snapshotArticleVersion,
  syncArticleTags,
  uniqueArticleSlug,
  type ArticleRow,
} from "./lib/kb-article-write";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type {
  CreateArticleInput,
  UpdateArticleInput,
  VerifyArticleInput,
  VoteArticleInput,
} from "../core/dto/kb.schemas";
import { KB_ARTICLE_COLUMNS } from "./kb-article-columns";

type ArticleWithTags = ArticleRow & { tags: string[] };

@Injectable()
export class KbArticlesService {
  private readonly logger = new Logger(KbArticlesService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: KbAccessService,
    private readonly events: KbEventsService,
  ) {}

  async get(user: CurrentUserContext, articleId: number): Promise<ArticleWithTags> {
    const article = await this.db.query.kbArticles.findFirst({
      where: and(eq(kbArticles.id, articleId), eq(kbArticles.orgId, user.orgId)),
      columns: { fts: false },
      with: { category: { columns: { id: true, name: true, slug: true } } },
    });
    if (!article) throw new NotFoundException("Article not found");
    await this.access.assertCanViewArticle(user, article);

    return { ...article, tags: await readArticleTags(this.db, user.orgId, articleId) };
  }

  async recordView(user: CurrentUserContext, articleId: number): Promise<{ success: boolean }> {
    await this.access.assertArticleViewable(user, articleId);
    await this.db
      .update(kbArticles)
      .set({ views: sql`${kbArticles.views} + 1` })
      .where(and(eq(kbArticles.id, articleId), eq(kbArticles.orgId, user.orgId)));
    await this.events.recordDetached(user.orgId, "view", {
      actorMembershipId: actingMembershipId(user.principal) ?? null,
      articleId,
    });
    return { success: true };
  }

  async create(user: CurrentUserContext, input: CreateArticleInput): Promise<ArticleWithTags> {
    const orgId = user.orgId;
    await this.access.assertSpaceAccessible(user, input.spaceId);

    const tagNames = input.tags ?? [];
    const maxAttempts = 3;
    for (let attempt = 1; ; attempt += 1) {
      const slug = await uniqueArticleSlug(this.db, orgId, input.title);
      try {
        return await this.db.transaction(async (tx) => {
          const [article] = await tx
            .insert(kbArticles)
            .values({
              orgId,
              spaceId: input.spaceId,
              categoryId: input.categoryId ?? null,
              title: input.title,
              slug,
              excerpt: input.excerpt ?? null,
              content: input.content ?? "",
              contentText: input.contentText ?? "",
              status: input.status,
              visibility: input.visibility,
              authorId: user.userId,
               ownerMembershipId: actingMembershipId(user.principal),
              seoTitle: input.seoTitle ?? null,
              seoDescription: input.seoDescription ?? null,
              reviewIntervalDays: input.reviewIntervalDays ?? null,
              publishedAt: input.status === "published" ? new Date() : null,
            })
            .returning(KB_ARTICLE_COLUMNS);

          await snapshotArticleVersion(tx, orgId, article, user.userId, undefined, actingMembershipId(user.principal));
          const resolvedTags = await syncArticleTags(tx, orgId, article.id, tagNames);
          return { ...article, tags: resolvedTags };
        });
      } catch (err) {
        if (attempt < maxAttempts && this.isUniqueViolation(err)) continue;
        throw err;
      }
    }
  }

  /**
   * The retry condition for a slug that lost a race.
   *
   * `create` computes a slug, inserts, and retries on a unique violation
   * because `uniq_kb_articles_org_slug` — (org_id, slug) — is what decides
   * between two authors who titled an article the same thing in the same
   * moment. This asked `"code" in err` of the value Drizzle threw, which keeps
   * the SQLSTATE on `.cause`: the answer was always false, so the retry loop
   * never retried and the loser got a 500 instead of a second slug.
   */
  private isUniqueViolation(err: unknown): boolean {
    return getPostgresErrorCode(err) === "23505";
  }

  async update(user: CurrentUserContext, articleId: number, input: UpdateArticleInput): Promise<ArticleWithTags> {
    await this.access.assertArticleEditable(user, articleId);
    const orgId = user.orgId;
    const current = await this.db.query.kbArticles.findFirst({
      where: and(eq(kbArticles.id, articleId), eq(kbArticles.orgId, orgId)),
      columns: { fts: false },
    });
    if (!current) throw new NotFoundException("Article not found");

    const values: Partial<typeof kbArticles.$inferInsert> = {};
    if (input.categoryId !== undefined) values.categoryId = input.categoryId;
    if (input.excerpt !== undefined) values.excerpt = input.excerpt;
    if (input.content !== undefined) values.content = input.content;
    if (input.contentText !== undefined) values.contentText = input.contentText;
    if (input.visibility !== undefined) values.visibility = input.visibility;
    if (input.seoTitle !== undefined) values.seoTitle = input.seoTitle;
    if (input.seoDescription !== undefined) values.seoDescription = input.seoDescription;
    if (input.reviewIntervalDays !== undefined) values.reviewIntervalDays = input.reviewIntervalDays;

    if (input.title !== undefined) {
      values.title = input.title;
      values.slug = await uniqueArticleSlug(this.db, orgId, input.title, articleId);
    }
    if (input.status !== undefined) {
      values.status = input.status;
      if (input.status === "published" && !current.publishedAt) values.publishedAt = new Date();
    }

    const titleChanged = input.title !== undefined && input.title !== current.title;
    const contentChanged = input.content !== undefined && input.content !== current.content;
    const aclChanged = input.visibility !== undefined && input.visibility !== current.visibility;

    const updated = await this.db.transaction(async (tx) => {
      const [result] = await tx
        .update(kbArticles)
        .set({
          ...values,
          updatedAt: new Date(),
          ...(contentChanged ? { contentRevision: sql`content_revision + 1` } : {}),
          ...(aclChanged ? { aclRevision: sql`acl_revision + 1` } : {}),
        })
        .where(
          and(
            eq(kbArticles.id, articleId),
            eq(kbArticles.orgId, orgId),
            eq(kbArticles.contentRevision, input.expectedContentRevision),
          ),
        )
        .returning(KB_ARTICLE_COLUMNS);
      if (!result) {
        throw new HttpException(
          { message: "Article was modified by another editor. Reload to see the latest version.", code: "STALE_REVISION" },
          HttpStatus.CONFLICT,
        );
      }

      if (titleChanged || contentChanged) {
        await snapshotArticleVersion(tx, orgId, result, user.userId, input.changeSummary, actingMembershipId(user.principal));
      }

      if (result.status === "published" && (contentChanged || aclChanged)) {
        await emitArticleIndexEvent(tx, orgId, articleId, result);
      }

      if (input.tags !== undefined) {
        const resolvedTags = await syncArticleTags(tx, orgId, articleId, input.tags ?? []);
        return { ...result, tags: resolvedTags };
      }

      return { ...result, tags: await readArticleTags(tx, orgId, articleId) };
    });

    return updated;
  }

  async archive(user: CurrentUserContext, articleId: number): Promise<ArticleRow> {
    await this.access.assertArticleEditable(user, articleId);
    const orgId = user.orgId;
    return this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(kbArticles)
        .set({ status: "archived", archivedAt: new Date() })
        .where(and(eq(kbArticles.id, articleId), eq(kbArticles.orgId, orgId)))
        .returning(KB_ARTICLE_COLUMNS);
      if (!updated) throw new NotFoundException("Article not found");
      await emitArticleIndexEvent(tx, orgId, articleId, updated);
      return updated;
    });
  }

  async publish(user: CurrentUserContext, articleId: number): Promise<ArticleRow> {
    await this.access.assertArticleEditable(user, articleId);
    const orgId = user.orgId;
    const updated = await this.db.transaction(async (tx) => {
      const current = await tx.query.kbArticles.findFirst({
        where: and(eq(kbArticles.id, articleId), eq(kbArticles.orgId, orgId)),
        columns: { publishedAt: true },
      });
      if (!current) throw new NotFoundException("Article not found");

      const [result] = await tx
        .update(kbArticles)
        .set({ status: "published", publishedAt: current.publishedAt ?? new Date() })
        .where(and(eq(kbArticles.id, articleId), eq(kbArticles.orgId, orgId)))
        .returning(KB_ARTICLE_COLUMNS);

      await snapshotArticleVersion(tx, orgId, result, user.userId, undefined, actingMembershipId(user.principal));
      await emitArticleIndexEvent(tx, orgId, articleId, result);
      return result;
    });

    return updated;
  }

  async unpublish(user: CurrentUserContext, articleId: number): Promise<ArticleRow> {
    await this.access.assertArticleEditable(user, articleId);
    const orgId = user.orgId;
    const updated = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(kbArticles)
        .set({ status: "draft" })
        .where(and(eq(kbArticles.id, articleId), eq(kbArticles.orgId, orgId)))
        .returning(KB_ARTICLE_COLUMNS);
      if (!row) throw new NotFoundException("Article not found");
      await emitArticleIndexEvent(tx, orgId, articleId, row);
      return row;
    });
    return updated;
  }

  async verify(user: CurrentUserContext, articleId: number, input: VerifyArticleInput): Promise<ArticleRow> {
    await this.access.assertArticleEditable(user, articleId);
    const orgId = user.orgId;
    const current = await this.db.query.kbArticles.findFirst({
      where: and(eq(kbArticles.id, articleId), eq(kbArticles.orgId, orgId)),
      columns: { reviewIntervalDays: true },
    });
    if (!current) throw new NotFoundException("Article not found");

    const [updated] = await this.db
      .update(kbArticles)
      .set({
        lastVerifiedAt: new Date(),
        reviewIntervalDays: input.reviewIntervalDays ?? current.reviewIntervalDays,
      })
      .where(and(eq(kbArticles.id, articleId), eq(kbArticles.orgId, orgId)))
      .returning(KB_ARTICLE_COLUMNS);
    return updated;
  }

  async vote(user: CurrentUserContext, articleId: number, input: VoteArticleInput): Promise<{ success: boolean }> {
    await this.access.assertArticleViewable(user, articleId);
    const orgId = user.orgId;

    await this.db.transaction(async (tx) => {
      await tx.insert(kbArticleFeedback).values({
        orgId,
        articleId,
        helpful: input.helpful,
        comment: input.comment ?? null,
        visitorId: user.userId,
      });

      await tx
        .update(kbArticles)
        .set(
          input.helpful
            ? { helpfulCount: sql`${kbArticles.helpfulCount} + 1` }
            : { notHelpfulCount: sql`${kbArticles.notHelpfulCount} + 1` },
        )
        .where(and(eq(kbArticles.id, articleId), eq(kbArticles.orgId, orgId)));
    });

    return { success: true };
  }

  async restoreVersion(user: CurrentUserContext, articleId: number, versionNumber: number): Promise<ArticleRow> {
    await this.access.assertArticleEditable(user, articleId);
    return restoreArticleVersion(this.db, user, articleId, versionNumber);
  }
}
