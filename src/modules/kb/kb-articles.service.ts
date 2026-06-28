import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, desc, eq, ilike, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import { kbArticles, kbArticleFeedback, kbArticleVersions } from "../../db/schema";
import { applyScope } from "../access/apply-scope";
import type { DataScope } from "../access/access.types";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { KbAccessService } from "./kb-access.service";
import { KbEventsService } from "./kb-events.service";
import { KbIndexingService } from "./kb-indexing.service";
import { kbSlugify } from "./kb.util";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type {
  CreateArticleInput,
  ListArticlesInput,
  UpdateArticleInput,
  VerifyArticleInput,
  VoteArticleInput,
} from "./dto/kb.schemas";

type KbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

type SnapshotSource = { id: number; title: string; content: string; excerpt: string | null };

type ArticleRow = typeof kbArticles.$inferSelect;

type ArticleListItem = Pick<
  ArticleRow,
  | "id"
  | "spaceId"
  | "categoryId"
  | "title"
  | "slug"
  | "excerpt"
  | "status"
  | "visibility"
  | "tags"
  | "ownerId"
  | "helpfulCount"
  | "notHelpfulCount"
  | "lastVerifiedAt"
  | "updatedAt"
>;

type ArticleListResult = {
  items: ArticleListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

@Injectable()
export class KbArticlesService {
  private readonly logger = new Logger(KbArticlesService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: KbAccessService,
    private readonly events: KbEventsService,
    private readonly indexing: KbIndexingService,
  ) {}

  async list(user: CurrentUserContext, query: ListArticlesInput, scope?: DataScope): Promise<ArticleListResult> {
    if (scope === "none") {
      return { items: [], total: 0, page: query.page, pageSize: query.pageSize, totalPages: 0 };
    }

    const ids = await this.access.getAccessibleSpaceIds(user);
    if (ids.length === 0) {
      return { items: [], total: 0, page: query.page, pageSize: query.pageSize, totalPages: 0 };
    }

    const conditions: SQL[] = [eq(kbArticles.orgId, user.orgId), inArray(kbArticles.spaceId, ids)];
    if (scope && scope !== "all") {
      conditions.push(applyScope(scope, user.userId, { ownerColumn: kbArticles.ownerId }));
    }
    if (query.spaceId) conditions.push(eq(kbArticles.spaceId, query.spaceId));
    if (query.categoryId) conditions.push(eq(kbArticles.categoryId, query.categoryId));
    if (query.status) conditions.push(eq(kbArticles.status, query.status));
    if (query.search) {
      const term = `%${query.search}%`;
      const match = or(ilike(kbArticles.title, term), ilike(kbArticles.excerpt, term));
      if (match) conditions.push(match);
    }

    const where = and(...conditions);

    const [totalRow] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(kbArticles)
      .where(where);
    const total = totalRow?.count ?? 0;

    const items = await this.db
      .select({
        id: kbArticles.id,
        spaceId: kbArticles.spaceId,
        categoryId: kbArticles.categoryId,
        title: kbArticles.title,
        slug: kbArticles.slug,
        excerpt: kbArticles.excerpt,
        status: kbArticles.status,
        visibility: kbArticles.visibility,
        tags: kbArticles.tags,
        ownerId: kbArticles.ownerId,
        helpfulCount: kbArticles.helpfulCount,
        notHelpfulCount: kbArticles.notHelpfulCount,
        lastVerifiedAt: kbArticles.lastVerifiedAt,
        updatedAt: kbArticles.updatedAt,
      })
      .from(kbArticles)
      .where(where)
      .orderBy(desc(kbArticles.updatedAt))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    return {
      items,
      total,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: Math.ceil(total / query.pageSize),
    };
  }

  async get(user: CurrentUserContext, articleId: number): Promise<ArticleRow> {
    const article = await this.db.query.kbArticles.findFirst({
      where: and(eq(kbArticles.id, articleId), eq(kbArticles.orgId, user.orgId)),
      with: { category: { columns: { id: true, name: true, slug: true } } },
    });
    if (!article) throw new NotFoundException("Article not found");
    await this.access.assertCanViewArticle(user, article);
    return article;
  }

  async recordView(user: CurrentUserContext, articleId: number): Promise<{ success: boolean }> {
    await this.access.assertArticleViewable(user, articleId);
    await this.db
      .update(kbArticles)
      .set({ views: sql`${kbArticles.views} + 1` })
      .where(and(eq(kbArticles.id, articleId), eq(kbArticles.orgId, user.orgId)));
    await this.events.record(user.orgId, "view", { actorId: user.userId, articleId });
    return { success: true };
  }

  async create(user: CurrentUserContext, input: CreateArticleInput): Promise<ArticleRow> {
    const orgId = user.orgId;
    await this.access.assertSpaceAccessible(user, input.spaceId);

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
              ownerId: user.userId,
              tags: input.tags ?? null,
              seoTitle: input.seoTitle ?? null,
              seoDescription: input.seoDescription ?? null,
              reviewIntervalDays: input.reviewIntervalDays ?? null,
              publishedAt: input.status === "published" ? new Date() : null,
            })
            .returning();

          await this.snapshot(tx, orgId, article, user.userId);
          return article;
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

  async update(user: CurrentUserContext, articleId: number, input: UpdateArticleInput): Promise<ArticleRow> {
    await this.access.assertArticleEditable(user, articleId);
    const orgId = user.orgId;
    const current = await this.db.query.kbArticles.findFirst({
      where: and(eq(kbArticles.id, articleId), eq(kbArticles.orgId, orgId)),
    });
    if (!current) throw new NotFoundException("Article not found");

    const values: Partial<typeof kbArticles.$inferInsert> = {};
    if (input.categoryId !== undefined) values.categoryId = input.categoryId;
    if (input.excerpt !== undefined) values.excerpt = input.excerpt;
    if (input.content !== undefined) values.content = input.content;
    if (input.contentText !== undefined) values.contentText = input.contentText;
    if (input.visibility !== undefined) values.visibility = input.visibility;
    if (input.tags !== undefined) values.tags = input.tags;
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

    if (Object.keys(values).length === 0) return current;

    const updated = await this.db.transaction(async (tx) => {
      const [result] = await tx
        .update(kbArticles)
        .set(values)
        .where(and(eq(kbArticles.id, articleId), eq(kbArticles.orgId, orgId)))
        .returning();
      if (titleChanged || contentChanged) {
        await this.snapshot(tx, orgId, result, user.userId, input.changeSummary);
      }
      return result;
    });

    if (updated.status === "published" && contentChanged) {
      try {
        await this.indexing.indexArticle(orgId, articleId);
      } catch (err) {
        this.logger.error(`Failed to index article ${articleId}: ${err}`);
      }
    }

    return updated;
  }

  async archive(user: CurrentUserContext, articleId: number): Promise<ArticleRow> {
    await this.access.assertArticleEditable(user, articleId);
    const orgId = user.orgId;
    const [updated] = await this.db
      .update(kbArticles)
      .set({ status: "archived", archivedAt: new Date() })
      .where(and(eq(kbArticles.id, articleId), eq(kbArticles.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Article not found");

    try {
      await this.indexing.removeArticleChunks(orgId, articleId);
    } catch (err) {
      this.logger.error(`Failed to remove indexed chunks for article ${articleId}: ${err}`);
    }

    return updated;
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
        .returning();

      await this.snapshot(tx, orgId, result, user.userId);
      return result;
    });

    try {
      await this.indexing.indexArticle(orgId, articleId);
    } catch (err) {
      this.logger.error(`Failed to index article ${articleId}: ${err}`);
    }

    return updated;
  }

  async unpublish(user: CurrentUserContext, articleId: number): Promise<ArticleRow> {
    await this.access.assertArticleEditable(user, articleId);
    const orgId = user.orgId;
    const [updated] = await this.db
      .update(kbArticles)
      .set({ status: "draft" })
      .where(and(eq(kbArticles.id, articleId), eq(kbArticles.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Article not found");

    try {
      await this.indexing.removeArticleChunks(orgId, articleId);
    } catch (err) {
      this.logger.error(`Failed to remove indexed chunks for article ${articleId}: ${err}`);
    }

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
      .returning();
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

  async listVersions(user: CurrentUserContext, articleId: number): Promise<(typeof kbArticleVersions.$inferSelect)[]> {
    await this.access.assertArticleViewable(user, articleId);
    return this.db.query.kbArticleVersions.findMany({
      where: and(eq(kbArticleVersions.articleId, articleId), eq(kbArticleVersions.orgId, user.orgId)),
      orderBy: [desc(kbArticleVersions.versionNumber)],
    });
  }

  async restoreVersion(user: CurrentUserContext, articleId: number, versionNumber: number): Promise<ArticleRow> {
    await this.access.assertArticleEditable(user, articleId);
    const orgId = user.orgId;
    return this.db.transaction(async (tx) => {
      const version = await tx.query.kbArticleVersions.findFirst({
        where: and(
          eq(kbArticleVersions.articleId, articleId),
          eq(kbArticleVersions.versionNumber, versionNumber),
          eq(kbArticleVersions.orgId, orgId),
        ),
      });
      if (!version) throw new NotFoundException("Version not found");

      const [updated] = await tx
        .update(kbArticles)
        .set({
          title: version.title,
          content: version.content,
          excerpt: version.excerpt,
          contentText: this.extractPlainText(version.content),
        })
        .where(and(eq(kbArticles.id, articleId), eq(kbArticles.orgId, orgId)))
        .returning();
      if (!updated) throw new NotFoundException("Article not found");

      await this.snapshot(tx, orgId, updated, user.userId, `Restored v${versionNumber}`);
      return updated;
    });
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
    let slug = root;
    let suffix = 1;
    while (true) {
      const conditions: SQL[] = [eq(kbArticles.orgId, orgId), eq(kbArticles.slug, slug)];
      if (excludeId !== undefined) conditions.push(ne(kbArticles.id, excludeId));
      const existing = await this.db.query.kbArticles.findFirst({
        where: and(...conditions),
        columns: { id: true },
      });
      if (!existing) return slug;
      suffix += 1;
      slug = `${root}-${suffix}`;
    }
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
    });
  }
}
