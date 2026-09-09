import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, ilike, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import {
  kbCategories,
  kbArticles,
  kbArticleTags,
  kbArticleVersions,
  kbTags,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import { recordArticleAttachmentPurge } from "../../kb/wiki/kb-page-attachment-purge";
import { KbIndexingService } from "../../kb/retrieval/kb-indexing.service";
import type {
  CreateKbArticleInput,
  CreateKbCategoryInput,
  ListKbArticlesInput,
  UpdateKbArticleInput,
  UpdateKbCategoryInput,
} from "./dto/support.schemas";
import { isUniqueViolation } from "../../../common/db/postgres-error";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

@Injectable()
export class SupportKbService {
  private readonly logger = new Logger(SupportKbService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly indexing: KbIndexingService,
  ) {}

  listCategories(orgId: string) {
    return this.db.query.kbCategories.findMany({
      where: eq(kbCategories.orgId, orgId),
      orderBy: [asc(kbCategories.sortOrder), asc(kbCategories.name)],
      limit: 100,
    });
  }

  async createCategory(orgId: string, input: CreateKbCategoryInput) {
    const slug = slugify(input.name);
    if (!slug) throw new BadRequestException("Invalid name");

    const existing = await this.db.query.kbCategories.findFirst({
      where: and(eq(kbCategories.orgId, orgId), eq(kbCategories.slug, slug)),
      columns: { id: true },
    });
    if (existing) throw new ConflictException("A category with this name already exists");

    const [category] = await this.db
      .insert(kbCategories)
      .values({
        orgId,
        name: input.name,
        slug,
        description: input.description ?? null,
        icon: input.icon ?? null,
        sortOrder: input.sortOrder ?? 0,
        isPublished: input.isPublished ?? false,
      })
      .returning()
      .catch((e: unknown) => {
        if (isUniqueViolation(e)) {
          throw new ConflictException("A category with this name already exists");
        }
        throw e;
      });
    return category;
  }

  async updateCategory(orgId: string, categoryId: number, input: UpdateKbCategoryInput) {
    const values: Partial<typeof kbCategories.$inferInsert> = {
      description: input.description,
      icon: input.icon,
      sortOrder: input.sortOrder,
      isPublished: input.isPublished,
    };
    if (input.name !== undefined) {
      const slug = slugify(input.name);
      if (!slug) throw new BadRequestException("Invalid name");
      const clash = await this.db.query.kbCategories.findFirst({
        where: and(
          eq(kbCategories.orgId, orgId),
          eq(kbCategories.slug, slug),
          ne(kbCategories.id, categoryId),
        ),
        columns: { id: true },
      });
      if (clash) throw new ConflictException("A category with this name already exists");
      values.name = input.name;
      values.slug = slug;
    }

    const [updated] = await this.db
      .update(kbCategories)
      .set({ ...values, updatedAt: new Date() })
      .where(and(eq(kbCategories.id, categoryId), eq(kbCategories.orgId, orgId)))
      .returning();

    if (!updated) throw new NotFoundException("Category not found");
    return updated;
  }

  async deleteCategory(orgId: string, categoryId: number) {
    const [deleted] = await this.db
      .delete(kbCategories)
      .where(and(eq(kbCategories.id, categoryId), eq(kbCategories.orgId, orgId)))
      .returning();

    if (!deleted) throw new NotFoundException("Category not found");
    return { success: true };
  }

  listArticles(orgId: string, query: ListKbArticlesInput) {
    const conditions: SQL[] = [eq(kbArticles.orgId, orgId)];
    if (query.status) conditions.push(eq(kbArticles.status, query.status));
    if (query.visibility) conditions.push(eq(kbArticles.visibility, query.visibility));
    if (query.categoryId) conditions.push(eq(kbArticles.categoryId, query.categoryId));
    if (query.search) {
      const term = `%${query.search}%`;
      const match = or(ilike(kbArticles.title, term), ilike(kbArticles.excerpt, term));
      if (match) conditions.push(match);
    }

    return this.db
      .select({
        id: kbArticles.id,
        orgId: kbArticles.orgId,
        categoryId: kbArticles.categoryId,
        title: kbArticles.title,
        slug: kbArticles.slug,
        excerpt: kbArticles.excerpt,
        status: kbArticles.status,
        visibility: kbArticles.visibility,
        authorId: kbArticles.authorId,
        views: kbArticles.views,
        helpfulCount: kbArticles.helpfulCount,
        notHelpfulCount: kbArticles.notHelpfulCount,
        tags: sql<string[]>`ARRAY(
          SELECT kt.name FROM kb_article_tags kat
          JOIN kb_tags kt ON kt.id = kat.tag_id
          WHERE kat.article_id = ${kbArticles.id}
          ORDER BY kt.name
        )`,
        publishedAt: kbArticles.publishedAt,
        createdAt: kbArticles.createdAt,
        updatedAt: kbArticles.updatedAt,
      })
      .from(kbArticles)
      .where(and(...conditions))
      .orderBy(desc(kbArticles.updatedAt))
      .limit(100);
  }

  async createArticle(orgId: string, userId: string, input: CreateKbArticleInput) {
    const slug = await this.uniqueArticleSlug(orgId, input.title);
    const tagNames = input.tags ?? [];

    return this.db.transaction(async (tx) => {
      const [article] = await tx
        .insert(kbArticles)
        .values({
          orgId,
          categoryId: input.categoryId ?? null,
          title: input.title,
          slug,
          excerpt: input.excerpt ?? null,
          content: input.content ?? "",
          status: input.status,
          visibility: input.visibility,
          authorId: userId,
          publishedAt: input.status === "published" ? new Date() : null,
        })
        .returning();

      const resolvedTags = await this.syncArticleTags(tx, orgId, article.id, tagNames);
      return { ...article, tags: resolvedTags };
    });
  }

  async getArticle(orgId: string, articleId: number) {
    const article = await this.db.query.kbArticles.findFirst({
      where: and(eq(kbArticles.id, articleId), eq(kbArticles.orgId, orgId)),
      columns: { fts: false },
      with: { category: { columns: { id: true, name: true, slug: true } } },
    });
    if (!article) throw new NotFoundException("Article not found");

    const tagRows = await this.db
      .select({ name: kbTags.name })
      .from(kbArticleTags)
      .innerJoin(kbTags, eq(kbArticleTags.tagId, kbTags.id))
      .where(and(eq(kbArticleTags.articleId, articleId), eq(kbTags.orgId, orgId)))
      .orderBy(asc(kbTags.name));

    return { ...article, tags: tagRows.map((t) => t.name) };
  }

  async updateArticle(
    orgId: string,
    articleId: number,
    input: UpdateKbArticleInput,
    authorId: string | null = null,
  ) {
    const current = await this.db.query.kbArticles.findFirst({
      where: and(eq(kbArticles.id, articleId), eq(kbArticles.orgId, orgId)),
      columns: {
        id: true,
        slug: true,
        status: true,
        publishedAt: true,
        title: true,
        content: true,
        visibility: true,
        contentRevision: true,
      },
    });
    if (!current) throw new NotFoundException("Article not found");

    const values: Partial<typeof kbArticles.$inferInsert> = {
      updatedAt: new Date(),
      categoryId: input.categoryId,
      excerpt: input.excerpt,
      content: input.content,
      visibility: input.visibility,
    };

    if (input.title !== undefined) {
      values.title = input.title;
      const slug = slugify(input.title);
      if (slug && slug !== current.slug) {
        const clash = await this.db.query.kbArticles.findFirst({
          where: and(
            eq(kbArticles.orgId, orgId),
            eq(kbArticles.slug, slug),
            ne(kbArticles.id, articleId),
          ),
          columns: { id: true },
        });
        if (!clash) values.slug = slug;
      }
    }

    if (input.status !== undefined) {
      values.status = input.status;
      if (input.status === "published" && !current.publishedAt) {
        values.publishedAt = new Date();
      }
    }

    const titleChanged = input.title !== undefined && input.title !== current.title;
    const contentChanged = input.content !== undefined && input.content !== current.content;
    const aclChanged = input.visibility !== undefined && input.visibility !== current.visibility;

    /**
     * The precondition comes from the client, not from the row this request just read — a
     * revision read microseconds earlier only closes the window inside one request and still
     * lets two editors overwrite each other. `updateKbArticleSchema` demands it whenever
     * content is written, so an unguarded body write cannot be expressed.
     */
    const revisionGuard = contentChanged ? input.expectedContentRevision : undefined;

    return this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(kbArticles)
        .set({
          ...values,
          ...(contentChanged ? { contentRevision: sql`content_revision + 1` } : {}),
          ...(aclChanged ? { aclRevision: sql`acl_revision + 1` } : {}),
        })
        .where(
          and(
            eq(kbArticles.id, articleId),
            eq(kbArticles.orgId, orgId),
            ...(revisionGuard === undefined ? [] : [eq(kbArticles.contentRevision, revisionGuard)]),
          ),
        )
        .returning();

      if (!updated) {
        if (revisionGuard === undefined) throw new NotFoundException("Article not found");
        throw new HttpException(
          { message: "Article was modified by another editor. Reload to see the latest version.", code: "STALE_REVISION" },
          HttpStatus.CONFLICT,
        );
      }

      if (titleChanged || contentChanged) await this.snapshot(tx, orgId, updated, authorId);

      if (updated.status === "published" && (contentChanged || aclChanged)) {
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
            contentRevision: updated.contentRevision,
            aclRevision: updated.aclRevision,
          },
          occurredAt: new Date(),
        });
      }

      if (input.tags !== undefined) {
        const tagNames = input.tags ?? [];
        const resolvedTags = await this.syncArticleTags(tx, orgId, articleId, tagNames);
        return { ...updated, tags: resolvedTags };
      }

      const tagRows = await tx
        .select({ name: kbTags.name })
        .from(kbArticleTags)
        .innerJoin(kbTags, eq(kbArticleTags.tagId, kbTags.id))
        .where(and(eq(kbArticleTags.articleId, articleId), eq(kbTags.orgId, orgId)))
        .orderBy(asc(kbTags.name));

      return { ...updated, tags: tagRows.map((t) => t.name) };
    });
  }

  async deleteArticle(orgId: string, articleId: number) {
    await recordArticleAttachmentPurge(this.db, orgId, [articleId]);

    const [deleted] = await this.db
      .delete(kbArticles)
      .where(and(eq(kbArticles.id, articleId), eq(kbArticles.orgId, orgId)))
      .returning();

    if (!deleted) throw new NotFoundException("Article not found");
    return { success: true };
  }

  private async snapshot(
    tx: Tx,
    orgId: string,
    article: { id: number; title: string; content: string; excerpt: string | null },
    authorId: string | null,
  ): Promise<void> {
    const [row] = await tx
      .select({ max: sql<number>`coalesce(max(${kbArticleVersions.versionNumber}), 0)::int` })
      .from(kbArticleVersions)
      .where(and(eq(kbArticleVersions.articleId, article.id), eq(kbArticleVersions.orgId, orgId)));

    await tx.insert(kbArticleVersions).values({
      orgId,
      articleId: article.id,
      versionNumber: (row?.max ?? 0) + 1,
      title: article.title,
      content: article.content,
      excerpt: article.excerpt,
      changeSummary: null,
      authorId,
      authorMembershipId: null,
    });
  }

  private async syncArticleTags(tx: Tx, orgId: string, articleId: number, tagNames: string[]): Promise<string[]> {
    await tx.delete(kbArticleTags).where(and(eq(kbArticleTags.orgId, orgId), eq(kbArticleTags.articleId, articleId)));

    if (tagNames.length === 0) return [];

    const slugged = tagNames
      .map((name) => ({ name, slug: slugify(name) }))
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

  private async uniqueArticleSlug(orgId: string, base: string): Promise<string> {
    const root = slugify(base) || "article";
    const rows = await this.db
      .select({ slug: kbArticles.slug })
      .from(kbArticles)
      .where(and(
        eq(kbArticles.orgId, orgId),
        sql`(${kbArticles.slug} = ${root} OR ${kbArticles.slug} LIKE ${root + "-%"})`,
      ));
    const taken = new Set(rows.map((r) => r.slug));
    if (!taken.has(root)) return root;
    let suffix = 2;
    while (taken.has(`${root}-${suffix}`)) suffix += 1;
    return `${root}-${suffix}`;
  }
}
