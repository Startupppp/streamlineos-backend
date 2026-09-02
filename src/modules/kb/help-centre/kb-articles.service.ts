import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import { kbArticles, kbArticleFeedback, kbArticleTags, kbArticleVersions, kbTags } from "../../../db/schema";
import { actingMembershipId } from "../../../common/auth/principal";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import { KbAccessService } from "../core/kb-access.service";
import { KbEventsService } from "../core/kb-events.service";
import { kbSlugify } from "../core/kb.util";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type {
  CreateArticleInput,
  UpdateArticleInput,
  VerifyArticleInput,
  VoteArticleInput,
} from "../core/dto/kb.schemas";
import { KB_ARTICLE_COLUMNS, type KbArticleRow } from "./kb-article-columns";

type KbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

type SnapshotSource = { id: number; title: string; content: string; excerpt: string | null };

type ArticleRow = KbArticleRow;

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

    const tagRows = await this.db
      .select({ name: kbTags.name })
      .from(kbArticleTags)
      .innerJoin(kbTags, eq(kbArticleTags.tagId, kbTags.id))
      .where(and(eq(kbArticleTags.articleId, articleId), eq(kbTags.orgId, user.orgId)))
      .orderBy(asc(kbTags.name));

    return { ...article, tags: tagRows.map((t) => t.name) };
  }

  async recordView(user: CurrentUserContext, articleId: number): Promise<{ success: boolean }> {
    await this.access.assertArticleViewable(user, articleId);
    await this.db
      .update(kbArticles)
      .set({ views: sql`${kbArticles.views} + 1` })
      .where(and(eq(kbArticles.id, articleId), eq(kbArticles.orgId, user.orgId)));
    await this.events.record(user.orgId, "view", { actorMembershipId: actingMembershipId(user.principal) ?? null, articleId });
    return { success: true };
  }

  async create(user: CurrentUserContext, input: CreateArticleInput): Promise<ArticleWithTags> {
    const orgId = user.orgId;
    await this.access.assertSpaceAccessible(user, input.spaceId);

    const tagNames = input.tags ?? [];
    const maxAttempts = 3;
    for (let attempt = 1; ; attempt += 1) {
      const slug = await this.uniqueArticleSlug(orgId, input.title);
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

          await this.snapshot(tx, orgId, article, user.userId, undefined, actingMembershipId(user.principal));
          const resolvedTags = await this.syncArticleTags(tx, orgId, article.id, tagNames);
          return { ...article, tags: resolvedTags };
        });
      } catch (err) {
        if (attempt < maxAttempts && this.isUniqueViolation(err)) continue;
        throw err;
      }
    }
  }

  private isUniqueViolation(err: unknown): boolean {
    return typeof err === "object" && err !== null && "code" in err && err.code === "23505";
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
      values.slug = await this.uniqueArticleSlug(orgId, input.title, articleId);
    }
    if (input.status !== undefined) {
      values.status = input.status;
      if (input.status === "published" && !current.publishedAt) values.publishedAt = new Date();
    }

    const titleChanged = input.title !== undefined && input.title !== current.title;
    const contentChanged = input.content !== undefined && input.content !== current.content;
    const aclChanged = input.visibility !== undefined && input.visibility !== current.visibility;

    const updated = await this.db.transaction(async (tx) => {
      let result: ArticleRow;
      if (Object.keys(values).length > 0) {
        const [row] = await tx
          .update(kbArticles)
          .set({
            ...values,
            ...(contentChanged ? { contentRevision: sql`content_revision + 1` } : {}),
            ...(aclChanged ? { aclRevision: sql`acl_revision + 1` } : {}),
          })
          .where(and(eq(kbArticles.id, articleId), eq(kbArticles.orgId, orgId)))
          .returning(KB_ARTICLE_COLUMNS);
        result = row;
      } else {
        result = current;
      }

      if (titleChanged || contentChanged) {
        await this.snapshot(tx, orgId, result, user.userId, input.changeSummary, actingMembershipId(user.principal));
      }

      if (result.status === "published" && (contentChanged || aclChanged)) {
        await OutboxWriter.emit(tx, {
          eventId: randomUUID(),
          organizationId: orgId,
          aggregateType: "kb_article",
          aggregateId: String(articleId),
          aggregateVersion: Date.now(),
          eventType: "kb.content.index",
          payload: {
            contentType: "article",
            contentId: articleId,
            contentRevision: result.contentRevision,
            aclRevision: result.aclRevision,
          },
          occurredAt: new Date(),
        });
      }

      if (input.tags !== undefined) {
        const resolvedTags = await this.syncArticleTags(tx, orgId, articleId, input.tags ?? []);
        return { ...result, tags: resolvedTags };
      }

      const tagRows = await tx
        .select({ name: kbTags.name })
        .from(kbArticleTags)
        .innerJoin(kbTags, eq(kbArticleTags.tagId, kbTags.id))
        .where(and(eq(kbArticleTags.articleId, articleId), eq(kbTags.orgId, orgId)))
        .orderBy(asc(kbTags.name));

      return { ...result, tags: tagRows.map((t) => t.name) };
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
      await OutboxWriter.emit(tx, {
        eventId: randomUUID(),
        organizationId: orgId,
        aggregateType: "kb_article",
        aggregateId: String(articleId),
        aggregateVersion: Date.now(),
        eventType: "kb.content.index",
        payload: { contentType: "article", contentId: articleId, contentRevision: updated.contentRevision, aclRevision: updated.aclRevision },
        occurredAt: new Date(),
      });
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

      await this.snapshot(tx, orgId, result, user.userId, undefined, actingMembershipId(user.principal));
      await OutboxWriter.emit(tx, {
        eventId: randomUUID(),
        organizationId: orgId,
        aggregateType: "kb_article",
        aggregateId: String(articleId),
        aggregateVersion: Date.now(),
        eventType: "kb.content.index",
        payload: { contentType: "article", contentId: articleId, contentRevision: result.contentRevision, aclRevision: result.aclRevision },
        occurredAt: new Date(),
      });
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
      await OutboxWriter.emit(tx, {
        eventId: randomUUID(),
        organizationId: orgId,
        aggregateType: "kb_article",
        aggregateId: String(articleId),
        aggregateVersion: Date.now(),
        eventType: "kb.content.index",
        payload: { contentType: "article", contentId: articleId, contentRevision: row.contentRevision, aclRevision: row.aclRevision },
        occurredAt: new Date(),
      });
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
    const orgId = user.orgId;
    const updated = await this.db.transaction(async (tx) => {
      const version = await tx.query.kbArticleVersions.findFirst({
        where: and(
          eq(kbArticleVersions.articleId, articleId),
          eq(kbArticleVersions.versionNumber, versionNumber),
          eq(kbArticleVersions.orgId, orgId),
        ),
      });
      if (!version) throw new NotFoundException("Version not found");

      const [result] = await tx
        .update(kbArticles)
        .set({
          title: version.title,
          content: version.content,
          excerpt: version.excerpt,
          contentText: this.extractPlainText(version.content),
          contentRevision: sql`content_revision + 1`,
        })
        .where(and(eq(kbArticles.id, articleId), eq(kbArticles.orgId, orgId)))
        .returning(KB_ARTICLE_COLUMNS);
      if (!result) throw new NotFoundException("Article not found");

      await this.snapshot(tx, orgId, result, user.userId, `Restored v${versionNumber}`, actingMembershipId(user.principal));
      if (result.status === "published") {
        await OutboxWriter.emit(tx, {
          eventId: randomUUID(),
          organizationId: orgId,
          aggregateType: "kb_article",
          aggregateId: String(articleId),
          aggregateVersion: Date.now(),
          eventType: "kb.content.index",
          payload: { contentType: "article", contentId: articleId, contentRevision: result.contentRevision, aclRevision: result.aclRevision },
          occurredAt: new Date(),
        });
      }
      return result;
    });

    return updated;
  }

  private async syncArticleTags(tx: KbTransaction, orgId: string, articleId: number, tagNames: string[]): Promise<string[]> {
    await tx.delete(kbArticleTags).where(and(eq(kbArticleTags.orgId, orgId), eq(kbArticleTags.articleId, articleId)));

    if (tagNames.length === 0) return [];

    const slugged = tagNames
      .map((name) => ({ name, slug: kbSlugify(name) }))
      .filter(({ slug }) => slug.length > 0);

    if (slugged.length === 0) return [];

    await tx
      .insert(kbTags)
      .values(slugged.map(({ name, slug }) => ({ orgId, name, slug })))
      .onConflictDoNothing();

    const tagRows = await tx
      .select({ id: kbTags.id, name: kbTags.name })
      .from(kbTags)
      .where(and(eq(kbTags.orgId, orgId), inArray(kbTags.slug, slugged.map((s) => s.slug))))
      .orderBy(asc(kbTags.name));

    if (tagRows.length > 0) {
      await tx
        .insert(kbArticleTags)
        .values(tagRows.map((t) => ({ orgId, articleId, tagId: t.id })))
        .onConflictDoNothing();
    }

    return tagRows.map((t) => t.name);
  }

  private extractPlainText(content: string): string {
    const parts: string[] = [];
    const walk = (node: unknown): void => {
      if (typeof node !== "object" || node === null) return;
      if ("text" in node && typeof node.text === "string") parts.push(node.text);
      if ("content" in node && Array.isArray(node.content)) {
        for (const child of node.content) walk(child);
      }
    };
    try {
      walk(JSON.parse(content));
    } catch {
      return content;
    }
    return parts.join(" ");
  }

  private async uniqueArticleSlug(orgId: string, base: string, excludeId?: number): Promise<string> {
    const root = kbSlugify(base) || "article";
    const conditions: SQL[] = [
      eq(kbArticles.orgId, orgId),
      sql`(${kbArticles.slug} = ${root} OR ${kbArticles.slug} LIKE ${root + "-%"})`,
    ];
    if (excludeId !== undefined) conditions.push(ne(kbArticles.id, excludeId));
    const rows = await this.db
      .select({ slug: kbArticles.slug })
      .from(kbArticles)
      .where(and(...conditions));
    const taken = new Set(rows.map((r) => r.slug));
    if (!taken.has(root)) return root;
    let suffix = 2;
    while (taken.has(`${root}-${suffix}`)) suffix += 1;
    return `${root}-${suffix}`;
  }

  private async nextVersionNumber(tx: KbTransaction, orgId: string, articleId: number): Promise<number> {
    const [row] = await tx
      .select({ max: sql<number>`coalesce(max(${kbArticleVersions.versionNumber}), 0)::int` })
      .from(kbArticleVersions)
      .where(and(eq(kbArticleVersions.articleId, articleId), eq(kbArticleVersions.orgId, orgId)));
    return (row?.max ?? 0) + 1;
  }

  private async snapshot(
    tx: KbTransaction,
    orgId: string,
    article: SnapshotSource,
    userId: string,
    changeSummary?: string,
    membershipId: number | null = null,
  ): Promise<void> {
    const versionNumber = await this.nextVersionNumber(tx, orgId, article.id);
    await tx.insert(kbArticleVersions).values({
      orgId,
      articleId: article.id,
      versionNumber,
      title: article.title,
      content: article.content,
      excerpt: article.excerpt,
      changeSummary: changeSummary ?? null,
      authorId: userId,
      authorMembershipId: membershipId,
    });
  }
}
