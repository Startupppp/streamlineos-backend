import { HttpException, HttpStatus, NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  kbPageTags,
  kbPageVersions,
  kbTags,
} from "../../../../db/schema";
import { type Db } from "../../../../db/drizzle.module";
import { KbPageWriterService } from "../../../kb/wiki/kb-page-writer.service";
import {
  articleContentToPageContent,
  articleVisibilityToPage,
  SUPPORT_ARTICLE_CONTENT_TYPE,
} from "../../../kb/help-centre/kb-article-page-scope";
import type {
  CreateKbArticleInput,
  ListKbArticlesInput,
  UpdateKbArticleInput,
} from "../dto/support.schemas";
import {
  findSupportArticleSlugConflict,
  findUsedSupportArticleSlugs,
  insertSupportArticle,
  listSupportArticles,
  lookupSupportArticle,
  lookupSupportArticleCurrentState,
  patchSupportArticle,
  softDeleteSupportArticle,
  type SupportArticlePatchValues,
} from "../../../kb/core/kb-support-documents";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

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
  const pageVisibility = query.visibility
    ? articleVisibilityToPage(query.visibility)
    : undefined;
  return listSupportArticles(db, orgId, {
    status: query.status,
    pageVisibility,
    categoryId: query.categoryId,
    search: query.search,
  });
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
    const article = await insertSupportArticle(tx, {
      orgId,
      categoryId: input.categoryId ?? null,
      title: input.title,
      slug,
      excerpt: input.excerpt ?? null,
      contentText,
      contentType: SUPPORT_ARTICLE_CONTENT_TYPE,
      status: input.status,
      visibility: articleVisibilityToPage(input.visibility),
      createdById: userId,
      publishedAt: input.status === "published" ? new Date() : null,
    });

    const resolvedTags = await syncArticleTags(tx, orgId, article.id, tagNames);
    return { ...article, tags: resolvedTags };
  });
}

export async function getArticle(db: Db, orgId: string, articleId: number) {
  const article = await lookupSupportArticle(db, orgId, articleId);
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
  writer: KbPageWriterService,
  orgId: string,
  articleId: number,
  input: UpdateKbArticleInput,
  authorId: string | null = null,
) {
  const current = await lookupSupportArticleCurrentState(db, orgId, articleId);
  if (!current) throw new NotFoundException("Article not found");

  const nextVisibility =
    input.visibility === undefined
      ? undefined
      : articleVisibilityToPage(input.visibility);

  const values: SupportArticlePatchValues = {
    updatedAt: new Date(),
    categoryId: input.categoryId,
    excerpt: input.excerpt,
    visibility: nextVisibility,
  };

  if (input.content !== undefined) {
    values.contentText = input.content;
  }

  if (input.title !== undefined) {
    values.title = input.title;
    const slug = slugify(input.title);
    if (slug && slug !== current.slug) {
      const hasConflict = await findSupportArticleSlugConflict(db, orgId, slug, articleId);
      if (!hasConflict) values.slug = slug;
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

  const revisionGuard = contentChanged
    ? input.expectedContentRevision
    : undefined;

  return db.transaction(async (tx) => {
    const updated = await patchSupportArticle(tx, orgId, articleId, values, {
      bumpContentRevision: contentChanged,
      bumpAclRevision: aclChanged,
      revisionGuard,
    });

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
      await writer.commitPageChange(tx, {
        orgId,
        actor: { userId: authorId ?? "", membershipId: null },
        page: {
          id: updated.id,
          title: updated.title,
          contentRevision: updated.contentRevision,
          aclRevision: updated.aclRevision,
          contentText: null,
        },
        changed: {},
      });
    }

    if (input.tags !== undefined) {
      const tagNames = input.tags ?? [];
      const resolvedTags = await syncArticleTags(tx, orgId, articleId, tagNames);
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
  const deleted = await softDeleteSupportArticle(db, orgId, articleId);
  if (!deleted) throw new NotFoundException("Article not found");
  return { success: true };
}

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
  const taken = await findUsedSupportArticleSlugs(db, orgId, root);
  if (!taken.has(root)) return root;
  let suffix = 2;
  while (taken.has(`${root}-${suffix}`)) suffix += 1;
  return `${root}-${suffix}`;
}
