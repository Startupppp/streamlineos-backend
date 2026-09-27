import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { kbCategories, kbPageFeedback, kbPages } from "../../../db/schema";
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
import {
  KB_ARTICLE_COLUMNS,
  toArticleRow,
  type ArticleWithCategory,
  type ArticleWithTags,
} from "./kb-article-columns";
import {
  SUPPORT_ARTICLE_CONTENT_TYPE,
  articleContentToPageContent,
  articleNextReviewAt,
  articleVerifiedUntil,
  articleVisibilityToPage,
  pageContentToArticleContent,
  supportArticlePredicate,
} from "./kb-article-page-scope";
import { KbReadMetrics } from "../analytics/kb-read-metrics";
import { KbWriteMetrics } from "../analytics/kb-write-metrics";

@Injectable()
export class KbArticlesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: KbAccessService,
    private readonly events: KbEventsService,
  ) {}

  private articleScope(orgId: string, articleId: number) {
    return and(
      eq(kbPages.id, articleId),
      eq(kbPages.orgId, orgId),
      supportArticlePredicate(),
    );
  }

  async get(
    user: CurrentUserContext,
    articleId: number,
  ): Promise<ArticleWithCategory> {
    const metrics = KbReadMetrics.begin({ orgId: user.orgId });
    try {
      const [row] = await this.db
        .select({
          ...KB_ARTICLE_COLUMNS,
          categoryName: kbCategories.name,
          categorySlug: kbCategories.slug,
        })
        .from(kbPages)
        .leftJoin(
          kbCategories,
          and(
            eq(kbCategories.orgId, kbPages.orgId),
            eq(kbCategories.id, kbPages.categoryId),
          ),
        )
        .where(this.articleScope(user.orgId, articleId))
        .limit(1);
      if (!row) throw new NotFoundException("Article not found");

      const { categoryName, categorySlug, ...page } = row;
      await this.access.assertCanViewArticle(user, {
        id: page.id,
        orgId: page.orgId,
        spaceId: page.spaceId,
      });

      metrics.finish("found");
      return {
        ...toArticleRow(page),
        category:
          page.categoryId === null ||
          categoryName === null ||
          categorySlug === null
            ? null
            : { id: page.categoryId, name: categoryName, slug: categorySlug },
        tags: await readArticleTags(this.db, user.orgId, articleId),
      };
    } catch (error) {
      if (error instanceof NotFoundException) metrics.finish("not_found");
      else if (error instanceof ForbiddenException) metrics.finish("denied");
      else metrics.finish("error");
      throw error;
    }
  }

  async recordView(
    user: CurrentUserContext,
    articleId: number,
  ): Promise<{ success: boolean }> {
    await this.access.assertArticleViewable(user, articleId);
    await this.db
      .update(kbPages)
      .set({ views: sql`coalesce(${kbPages.views}, 0) + 1` })
      .where(this.articleScope(user.orgId, articleId));
    await this.events.recordDetached(user.orgId, "view", {
      actorMembershipId: actingMembershipId(user.principal) ?? null,
      articleId,
    });
    return { success: true };
  }

  async create(
    user: CurrentUserContext,
    input: CreateArticleInput,
  ): Promise<ArticleWithTags> {
    const metrics = KbWriteMetrics.begin({ orgId: user.orgId });
    try {
      const orgId = user.orgId;
      await this.access.assertSpaceAccessible(user, input.spaceId);

      const tagNames = input.tags ?? [];
      const maxAttempts = 3;
      for (let attempt = 1; ; attempt += 1) {
        const slug = await uniqueArticleSlug(this.db, orgId, input.title);
        try {
          const result = await this.db.transaction(async (tx) => {
            const [article] = await tx
              .insert(kbPages)
              .values({
                orgId,
                spaceId: input.spaceId,
                categoryId: input.categoryId ?? null,
                title: input.title,
                slug,
                excerpt: input.excerpt ?? null,
                content: articleContentToPageContent(
                  input.content,
                  input.contentText,
                ),
                contentText: input.contentText ?? "",
                contentType: SUPPORT_ARTICLE_CONTENT_TYPE,
                status: input.status,
                visibility: articleVisibilityToPage(input.visibility),
                createdById: user.userId,
                ownerMembershipId: actingMembershipId(user.principal),
                seoTitle: input.seoTitle ?? null,
                seoDescription: input.seoDescription ?? null,
                reviewIntervalDays: input.reviewIntervalDays ?? null,
                publishedAt: input.status === "published" ? new Date() : null,
              })
              .returning(KB_ARTICLE_COLUMNS);

            await snapshotArticleVersion(
              tx,
              orgId,
              article,
              user.userId,
              undefined,
              actingMembershipId(user.principal),
            );
            const resolvedTags = await syncArticleTags(
              tx,
              orgId,
              article.id,
              tagNames,
            );
            return { ...toArticleRow(article), tags: resolvedTags };
          });
          metrics.finish("created");
          return result;
        } catch (err) {
          if (attempt < maxAttempts && this.isUniqueViolation(err)) continue;
          throw err;
        }
      }
    } catch (error) {
      if (error instanceof ForbiddenException) metrics.finish("denied");
      else metrics.finish("error");
      throw error;
    }
  }

  private isUniqueViolation(err: unknown): boolean {
    return getPostgresErrorCode(err) === "23505";
  }

  async update(
    user: CurrentUserContext,
    articleId: number,
    input: UpdateArticleInput,
  ): Promise<ArticleWithTags> {
    const metrics = KbWriteMetrics.begin({ orgId: user.orgId });
    try {
      await this.access.assertArticleEditable(user, articleId);
      const orgId = user.orgId;
      const [current] = await this.db
        .select(KB_ARTICLE_COLUMNS)
        .from(kbPages)
        .where(this.articleScope(orgId, articleId))
        .limit(1);
      if (!current) throw new NotFoundException("Article not found");

      const values: Partial<typeof kbPages.$inferInsert> = {};
      if (input.categoryId !== undefined) values.categoryId = input.categoryId;
      if (input.excerpt !== undefined) values.excerpt = input.excerpt;
      if (input.content !== undefined)
        values.content = articleContentToPageContent(
          input.content,
          input.contentText,
        );
      if (input.contentText !== undefined) values.contentText = input.contentText;
      if (input.visibility !== undefined)
        values.visibility = articleVisibilityToPage(input.visibility);
      if (input.seoTitle !== undefined) values.seoTitle = input.seoTitle;
      if (input.seoDescription !== undefined)
        values.seoDescription = input.seoDescription;
      if (input.reviewIntervalDays !== undefined)
        values.reviewIntervalDays = input.reviewIntervalDays;

      if (input.title !== undefined) {
        values.title = input.title;
        values.slug = await uniqueArticleSlug(
          this.db,
          orgId,
          input.title,
          articleId,
        );
      }
      if (input.status !== undefined) {
        values.status = input.status;
        if (input.status === "published" && !current.publishedAt)
          values.publishedAt = new Date();
      }

      const titleChanged =
        input.title !== undefined && input.title !== current.title;
      const contentChanged =
        input.content !== undefined &&
        input.content !== pageContentToArticleContent(current.content);
      const aclChanged =
        input.visibility !== undefined &&
        articleVisibilityToPage(input.visibility) !== current.visibility;

      const result = await this.db.transaction(async (tx) => {
        const [updated] = await tx
          .update(kbPages)
          .set({
            ...values,
            updatedAt: new Date(),
            ...(contentChanged
              ? { contentRevision: sql`content_revision + 1` }
              : {}),
            ...(aclChanged ? { aclRevision: sql`acl_revision + 1`, aclRevisionChangedAt: new Date() } : {}),
          })
          .where(
            and(
              this.articleScope(orgId, articleId),
              eq(kbPages.contentRevision, input.expectedContentRevision),
            ),
          )
          .returning(KB_ARTICLE_COLUMNS);
        if (!updated) {
          throw new HttpException(
            {
              message:
                "Article was modified by another editor. Reload to see the latest version.",
              code: "STALE_REVISION",
            },
            HttpStatus.CONFLICT,
          );
        }

        if (titleChanged || contentChanged) {
          await snapshotArticleVersion(
            tx,
            orgId,
            updated,
            user.userId,
            input.changeSummary,
            actingMembershipId(user.principal),
          );
        }

        if (updated.status === "published" && (contentChanged || aclChanged)) {
          await emitArticleIndexEvent(tx, orgId, articleId, updated);
        }

        const tags =
          input.tags !== undefined
            ? await syncArticleTags(tx, orgId, articleId, input.tags)
            : await readArticleTags(tx, orgId, articleId);

        return { ...toArticleRow(updated), tags };
      });
      metrics.finish("updated");
      return result;
    } catch (error) {
      if (error instanceof ForbiddenException) metrics.finish("denied");
      else if (error instanceof HttpException && error.getStatus() === HttpStatus.CONFLICT) metrics.finish("conflict");
      else metrics.finish("error");
      throw error;
    }
  }

  async archive(
    user: CurrentUserContext,
    articleId: number,
  ): Promise<ArticleRow> {
    await this.access.assertArticleEditable(user, articleId);
    const orgId = user.orgId;
    return this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(kbPages)
        .set({ status: "archived", archivedAt: new Date() })
        .where(this.articleScope(orgId, articleId))
        .returning(KB_ARTICLE_COLUMNS);
      if (!updated) throw new NotFoundException("Article not found");
      await emitArticleIndexEvent(tx, orgId, articleId, updated);
      return toArticleRow(updated);
    });
  }

  async publish(
    user: CurrentUserContext,
    articleId: number,
  ): Promise<ArticleRow> {
    await this.access.assertArticleEditable(user, articleId);
    const orgId = user.orgId;
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select({ publishedAt: kbPages.publishedAt })
        .from(kbPages)
        .where(this.articleScope(orgId, articleId))
        .limit(1);
      if (!current) throw new NotFoundException("Article not found");

      const [result] = await tx
        .update(kbPages)
        .set({
          status: "published",
          publishedAt: current.publishedAt ?? new Date(),
        })
        .where(this.articleScope(orgId, articleId))
        .returning(KB_ARTICLE_COLUMNS);
      if (!result) throw new NotFoundException("Article not found");

      await snapshotArticleVersion(
        tx,
        orgId,
        result,
        user.userId,
        undefined,
        actingMembershipId(user.principal),
      );
      await emitArticleIndexEvent(tx, orgId, articleId, result);
      return toArticleRow(result);
    });
  }

  async unpublish(
    user: CurrentUserContext,
    articleId: number,
  ): Promise<ArticleRow> {
    await this.access.assertArticleEditable(user, articleId);
    const orgId = user.orgId;
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(kbPages)
        .set({ status: "draft" })
        .where(this.articleScope(orgId, articleId))
        .returning(KB_ARTICLE_COLUMNS);
      if (!row) throw new NotFoundException("Article not found");
      await emitArticleIndexEvent(tx, orgId, articleId, row);
      return toArticleRow(row);
    });
  }

  async verify(
    user: CurrentUserContext,
    articleId: number,
    input: VerifyArticleInput,
  ): Promise<ArticleRow> {
    await this.access.assertArticleEditable(user, articleId);
    const orgId = user.orgId;
    const [current] = await this.db
      .select({ reviewIntervalDays: kbPages.reviewIntervalDays })
      .from(kbPages)
      .where(this.articleScope(orgId, articleId))
      .limit(1);
    if (!current) throw new NotFoundException("Article not found");

    const verifiedAt = new Date();
    const reviewIntervalDays =
      input.reviewIntervalDays ?? current.reviewIntervalDays;
    const [updated] = await this.db
      .update(kbPages)
      .set({
        trustState: "verified",
        verifiedAt,
        verifiedUntil: articleVerifiedUntil(verifiedAt),
        verifiedById: user.userId,
        verifiedByMembershipId: actingMembershipId(user.principal),
        nextReviewAt: articleNextReviewAt(verifiedAt, reviewIntervalDays),
        reviewIntervalDays,
      })
      .where(this.articleScope(orgId, articleId))
      .returning(KB_ARTICLE_COLUMNS);
    if (!updated) throw new NotFoundException("Article not found");
    return toArticleRow(updated);
  }

  async vote(
    user: CurrentUserContext,
    articleId: number,
    input: VoteArticleInput,
  ): Promise<{ success: boolean }> {
    await this.access.assertArticleViewable(user, articleId);
    const orgId = user.orgId;

    try {
      await this.db.transaction(async (tx) => {
        await tx.insert(kbPageFeedback).values({
          orgId,
          pageId: articleId,
          helpful: input.helpful,
          comment: input.comment ?? null,
          visitorId: user.userId,
        });

        await tx
          .update(kbPages)
          .set(
            input.helpful
              ? { helpfulCount: sql`coalesce(${kbPages.helpfulCount}, 0) + 1` }
              : {
                  notHelpfulCount: sql`coalesce(${kbPages.notHelpfulCount}, 0) + 1`,
                },
          )
          .where(this.articleScope(orgId, articleId));
      });
    } catch (err) {
      if (this.isUniqueViolation(err))
        throw new ConflictException("You have already rated this article");
      throw err;
    }

    return { success: true };
  }

  async restoreVersion(
    user: CurrentUserContext,
    articleId: number,
    versionNumber: number,
  ): Promise<ArticleRow> {
    await this.access.assertArticleEditable(user, articleId);
    return restoreArticleVersion(this.db, user, articleId, versionNumber);
  }
}
