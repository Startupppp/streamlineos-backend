import { HttpException, HttpStatus, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  kbPages,
  kbPageTags,
  kbPageVersions,
  kbTags,
} from "../../../../db/schema";
import { type Db } from "../../../../db/drizzle.module";
import { OutboxWriter } from "../../../../common/outbox/outbox-writer";
import {
  articleContentToPageContent,
  articleVisibilityToPage,
  SUPPORT_ARTICLE_CONTENT_TYPE,
  supportArticlePredicate,
  type ArticleVisibility,
} from "../../../kb/help-centre/kb-article-page-scope";
import type {
  CreateKbArticleInput,
  ListKbArticlesInput,
  UpdateKbArticleInput,
} from "../dto/support.schemas";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const articleVisibility = sql<ArticleVisibility>`case when ${kbPages.visibility} = 'public' then 'public' else 'internal' end`;

const articleListProjection = {
  id: kbPages.id,
  orgId: kbPages.orgId,
  categoryId: kbPages.categoryId,
  title: kbPages.title,
  slug: sql<string>`coalesce(${kbPages.slug}, '')`,
  excerpt: kbPages.excerpt,
  status: kbPages.status,
  visibility: articleVisibility,
  authorId: kbPages.createdById,
  views: sql<number>`coalesce(${kbPages.views}, 0)::int`,
  helpfulCount: sql<number>`coalesce(${kbPages.helpfulCount}, 0)::int`,
  notHelpfulCount: sql<number>`coalesce(${kbPages.notHelpfulCount}, 0)::int`,
  publishedAt: kbPages.publishedAt,
  createdAt: kbPages.createdAt,
  updatedAt: kbPages.updatedAt,
};

const articleWriteProjection = {
  ...articleListProjection,
  aclRevision: kbPages.aclRevision,
  contentRevision: kbPages.contentRevision,
};

const tagNameArray = sql<string[]>`ARRAY(
    SELECT kt.name FROM kb_page_tags kpt
    JOIN kb_tags kt ON kt.id = kpt.tag_id
    WHERE kpt.page_id = ${kbPages.id}
    ORDER BY kt.name
  )`;

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function listArticles(
  db: Db,
  orgId: string,
  query: ListKbArticlesInput,
) {
  const conditions: SQL[] = [
    eq(kbPages.orgId, orgId),
    supportArticlePredicate(),
  ];
  if (query.status) conditions.push(eq(kbPages.status, query.status));
  if (query.visibility)
    conditions.push(
      eq(kbPages.visibility, articleVisibilityToPage(query.visibility)),
    );
  if (query.categoryId)
    conditions.push(eq(kbPages.categoryId, query.categoryId));
  if (query.search) {
    const term = `%${query.search}%`;
    const match = or(ilike(kbPages.title, term), ilike(kbPages.excerpt, term));
    if (match) conditions.push(match);
  }

  return db
    .select({ ...articleListProjection, tags: tagNameArray })
    .from(kbPages)
    .where(and(...conditions))
    .orderBy(desc(kbPages.updatedAt))
    .limit(100);
}

export async function createArticle(
  db: Db,
  orgId: string,
  userId: string,
  input: CreateKbArticleInput,
) {
  const slug = await uniqueArticleSlug(db, orgId, input.title);
  const tagNames = input.tags ?? [];
  const contentText = input.content ?? "";

  return db.transaction(async (tx) => {
    const [article] = await tx
      .insert(kbPages)
      .values({
        orgId,
        categoryId: input.categoryId ?? null,
        title: input.title,
        slug,
        excerpt: input.excerpt ?? null,
        content: articleContentToPageContent(undefined, contentText),
        contentText,
        contentType: SUPPORT_ARTICLE_CONTENT_TYPE,
        status: input.status,
        visibility: articleVisibilityToPage(input.visibility),
        createdById: userId,
        publishedAt: input.status === "published" ? new Date() : null,
      })
      .returning(articleListProjection);

    const resolvedTags = await syncArticleTags(tx, orgId, article.id, tagNames);
    return { ...article, tags: resolvedTags };
  });
}

export async function getArticle(db: Db, orgId: string, articleId: number) {
  const [article] = await db
    .select({
      id: kbPages.id,
      orgId: kbPages.orgId,
      categoryId: kbPages.categoryId,
      spaceId: kbPages.spaceId,
      title: kbPages.title,
      slug: sql<string>`coalesce(${kbPages.slug}, '')`,
      excerpt: kbPages.excerpt,
      content: sql<string>`coalesce(${kbPages.contentText}, '')`,
      contentText: sql<string>`coalesce(${kbPages.contentText}, '')`,
      status: kbPages.status,
      visibility: articleVisibility,
      authorId: kbPages.createdById,
      ownerMembershipId: kbPages.ownerMembershipId,
      views: sql<number>`coalesce(${kbPages.views}, 0)::int`,
      helpfulCount: sql<number>`coalesce(${kbPages.helpfulCount}, 0)::int`,
      notHelpfulCount: sql<number>`coalesce(${kbPages.notHelpfulCount}, 0)::int`,
      seoTitle: kbPages.seoTitle,
      seoDescription: kbPages.seoDescription,
      reviewIntervalDays: kbPages.reviewIntervalDays,
      verifiedAt: kbPages.verifiedAt,
      publishedAt: kbPages.publishedAt,
      archivedAt: kbPages.archivedAt,
      createdAt: kbPages.createdAt,
      updatedAt: kbPages.updatedAt,
      aclRevision: kbPages.aclRevision,
      contentRevision: kbPages.contentRevision,
    })
    .from(kbPages)
    .where(
      and(
        eq(kbPages.id, articleId),
        eq(kbPages.orgId, orgId),
        supportArticlePredicate(),
      ),
    )
    .limit(1);

  if (!article) throw new NotFoundException("Article not found");

  const tagRows = await db
    .select({ name: kbTags.name })
    .from(kbPageTags)
    .innerJoin(kbTags, eq(kbPageTags.tagId, kbTags.id))
    .where(and(eq(kbPageTags.pageId, articleId), eq(kbTags.orgId, orgId)))
    .orderBy(asc(kbTags.name));

  const { verifiedAt, ...row } = article;
  return {
    ...row,
    lastVerifiedAt: verifiedAt,
    tags: tagRows.map((t) => t.name),
  };
}

export async function updateArticle(
  db: Db,
  orgId: string,
  articleId: number,
  input: UpdateKbArticleInput,
  authorId: string | null = null,
) {
  const [current] = await db
    .select({
      id: kbPages.id,
      slug: kbPages.slug,
      status: kbPages.status,
      publishedAt: kbPages.publishedAt,
      title: kbPages.title,
      contentText: kbPages.contentText,
      visibility: kbPages.visibility,
      contentRevision: kbPages.contentRevision,
    })
    .from(kbPages)
    .where(
      and(
        eq(kbPages.id, articleId),
        eq(kbPages.orgId, orgId),
        supportArticlePredicate(),
      ),
    )
    .limit(1);
  if (!current) throw new NotFoundException("Article not found");

  const nextVisibility =
    input.visibility === undefined
      ? undefined
      : articleVisibilityToPage(input.visibility);

  const values: Partial<typeof kbPages.$inferInsert> = {
    updatedAt: new Date(),
    categoryId: input.categoryId,
    excerpt: input.excerpt,
    visibility: nextVisibility,
  };

  if (input.content !== undefined) {
    values.contentText = input.content;
    values.content = articleContentToPageContent(undefined, input.content);
  }

  if (input.title !== undefined) {
    values.title = input.title;
    const slug = slugify(input.title);
    if (slug && slug !== current.slug) {
      const [clash] = await db
        .select({ id: kbPages.id })
        .from(kbPages)
        .where(
          and(
            eq(kbPages.orgId, orgId),
            eq(kbPages.slug, slug),
            ne(kbPages.id, articleId),
          ),
        )
        .limit(1);
      if (!clash) values.slug = slug;
    }
  }

  if (input.status !== undefined) {
    values.status = input.status;
    if (input.status === "published" && !current.publishedAt) {
      values.publishedAt = new Date();
    }
  }

  const titleChanged =
    input.title !== undefined && input.title !== current.title;
  const contentChanged =
    input.content !== undefined &&
    input.content !== (current.contentText ?? "");
  const aclChanged =
    nextVisibility !== undefined && nextVisibility !== current.visibility;

  /**
   * The precondition comes from the client, not from the row this request just read — a
   * revision read microseconds earlier only closes the window inside one request and still
   * lets two editors overwrite each other. `updateKbArticleSchema` demands it whenever
   * content is written, so an unguarded body write cannot be expressed.
   */
  const revisionGuard = contentChanged
    ? input.expectedContentRevision
    : undefined;

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(kbPages)
      .set({
        ...values,
        ...(contentChanged
          ? { contentRevision: sql`content_revision + 1` }
          : {}),
        ...(aclChanged ? { aclRevision: sql`acl_revision + 1` } : {}),
      })
      .where(
        and(
          eq(kbPages.id, articleId),
          eq(kbPages.orgId, orgId),
          supportArticlePredicate(),
          ...(revisionGuard === undefined
            ? []
            : [eq(kbPages.contentRevision, revisionGuard)]),
        ),
      )
      .returning(articleWriteProjection);

    if (!updated) {
      if (revisionGuard === undefined)
        throw new NotFoundException("Article not found");
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
      await snapshotArticle(
        tx,
        orgId,
        {
          id: updated.id,
          title: updated.title,
          contentText: input.content ?? current.contentText ?? "",
          excerpt: updated.excerpt,
        },
        authorId,
      );
    }

    if (updated.status === "published" && (contentChanged || aclChanged)) {
      await OutboxWriter.emit(tx, {
        eventId: randomUUID(),
        organizationId: orgId,
        aggregateType: "kb_page",
        aggregateId: String(articleId),
        aggregateVersion: Date.now(),
        eventType: "kb.content.index",
        payload: {
          contentType: "page",
          contentId: articleId,
          contentRevision: updated.contentRevision,
          aclRevision: updated.aclRevision,
        },
        occurredAt: new Date(),
      });
    }

    if (input.tags !== undefined) {
      const tagNames = input.tags ?? [];
      const resolvedTags = await syncArticleTags(
        tx,
        orgId,
        articleId,
        tagNames,
      );
      return { ...updated, tags: resolvedTags };
    }

    const tagRows = await tx
      .select({ name: kbTags.name })
      .from(kbPageTags)
      .innerJoin(kbTags, eq(kbPageTags.tagId, kbTags.id))
      .where(and(eq(kbPageTags.pageId, articleId), eq(kbTags.orgId, orgId)))
      .orderBy(asc(kbTags.name));

    return { ...updated, tags: tagRows.map((t) => t.name) };
  });
}

export async function deleteArticle(db: Db, orgId: string, articleId: number) {
  const [deleted] = await db
    .update(kbPages)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(kbPages.id, articleId),
        eq(kbPages.orgId, orgId),
        supportArticlePredicate(),
      ),
    )
    .returning({ id: kbPages.id });

  if (!deleted) throw new NotFoundException("Article not found");
  return { success: true };
}

/** Appends the article's post-edit title and body as the next row of `kb_page_versions`. */
async function snapshotArticle(
  tx: Tx,
  orgId: string,
  article: {
    id: number;
    title: string;
    contentText: string;
    excerpt: string | null;
  },
  authorId: string | null,
): Promise<void> {
  const [row] = await tx
    .select({
      max: sql<number>`coalesce(max(${kbPageVersions.versionNumber}), 0)::int`,
    })
    .from(kbPageVersions)
    .where(
      and(
        eq(kbPageVersions.pageId, article.id),
        eq(kbPageVersions.orgId, orgId),
      ),
    );

  await tx.insert(kbPageVersions).values({
    orgId,
    pageId: article.id,
    versionNumber: (row?.max ?? 0) + 1,
    title: article.title,
    content: articleContentToPageContent(undefined, article.contentText),
    contentText: article.contentText,
    excerpt: article.excerpt,
    changeSummary: null,
    authorId,
    authorMembershipId: null,
  });
}

async function syncArticleTags(
  tx: Tx,
  orgId: string,
  pageId: number,
  tagNames: string[],
): Promise<string[]> {
  await tx
    .delete(kbPageTags)
    .where(and(eq(kbPageTags.orgId, orgId), eq(kbPageTags.pageId, pageId)));

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
    .where(
      and(
        eq(kbTags.orgId, orgId),
        inArray(
          kbTags.slug,
          slugged.map((s) => s.slug),
        ),
      ),
    )
    .orderBy(asc(kbTags.name));

  if (tagRows.length > 0) {
    await tx
      .insert(kbPageTags)
      .values(tagRows.map((t) => ({ orgId, pageId, tagId: t.id })))
      .onConflictDoNothing();
  }

  return tagRows.map((t) => t.name);
}

async function uniqueArticleSlug(
  db: Db,
  orgId: string,
  base: string,
): Promise<string> {
  const root = slugify(base) || "article";
  const rows = await db
    .select({ slug: kbPages.slug })
    .from(kbPages)
    .where(
      and(
        eq(kbPages.orgId, orgId),
        sql`(${kbPages.slug} = ${root} OR ${kbPages.slug} LIKE ${root + "-%"})`,
      ),
    );
  const taken = new Set(rows.map((r) => r.slug));
  if (!taken.has(root)) return root;
  let suffix = 2;
  while (taken.has(`${root}-${suffix}`)) suffix += 1;
  return `${root}-${suffix}`;
}
