import { and, desc, eq, ilike, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import {
  kbArticleChunks,
  kbPages,
  kbSpaces,
} from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import type { TenantTx } from "../../../db/drizzle.types";
import { NotFoundException } from "@nestjs/common";
import {
  articleContentToPageContent,
  SUPPORT_ARTICLE_CONTENT_TYPE,
  supportArticlePredicate,
  type ArticleVisibility,
} from "../help-centre/kb-article-page-scope";
import { buildArticleRestrictionBranch } from "./authorization/knowledge-page-scope";

export type EngagementKind = "view" | "helpful" | "not_helpful";

export type SupportKbSearchPrincipal = {
  membershipId: number | null;
  roleSlugs: string[];
};

export type SupportArticlePatchValues = Omit<
  Partial<typeof kbPages.$inferInsert>,
  "contentRevision" | "aclRevision"
>;

const supportArticleVisibility = sql<ArticleVisibility>`case when ${kbPages.visibility} = 'public' then 'public' else 'internal' end`;

const listProjection = {
  id: kbPages.id,
  orgId: kbPages.orgId,
  categoryId: kbPages.categoryId,
  title: kbPages.title,
  slug: sql<string>`coalesce(${kbPages.slug}, '')`,
  excerpt: kbPages.excerpt,
  status: kbPages.status,
  visibility: supportArticleVisibility,
  authorId: kbPages.createdById,
  views: sql<number>`coalesce(${kbPages.views}, 0)::int`,
  helpfulCount: sql<number>`coalesce(${kbPages.helpfulCount}, 0)::int`,
  notHelpfulCount: sql<number>`coalesce(${kbPages.notHelpfulCount}, 0)::int`,
  publishedAt: kbPages.publishedAt,
  createdAt: kbPages.createdAt,
  updatedAt: kbPages.updatedAt,
};

const writeProjection = {
  ...listProjection,
  aclRevision: kbPages.aclRevision,
  contentRevision: kbPages.contentRevision,
};

const tagNameArray = sql<string[]>`ARRAY(
    SELECT kt.name FROM kb_page_tags kpt
    JOIN kb_tags kt ON kt.id = kpt.tag_id
    WHERE kpt.page_id = ${kbPages.id}
    ORDER BY kt.name
  )`;

export async function verifySupportArticle(
  db: Db,
  orgId: string,
  articleId: number,
): Promise<void> {
  const article = await db.query.kbPages.findFirst({
    where: and(
      eq(kbPages.id, articleId),
      eq(kbPages.orgId, orgId),
      supportArticlePredicate(),
      isNull(kbPages.archivedAt),
    ),
    columns: { id: true },
  });
  if (!article) throw new NotFoundException("Article not found");
}

export async function recordEngagement(
  tx: TenantTx,
  pageId: number,
  kind: EngagementKind,
): Promise<void> {
  const increment =
    kind === "view"
      ? { views: sql<number>`coalesce(${kbPages.views}, 0) + 1` }
      : kind === "helpful"
        ? { helpfulCount: sql<number>`coalesce(${kbPages.helpfulCount}, 0) + 1` }
        : { notHelpfulCount: sql<number>`coalesce(${kbPages.notHelpfulCount}, 0) + 1` };
  await tx.update(kbPages).set(increment).where(eq(kbPages.id, pageId));
}

export async function searchSupportDocuments(
  db: Db,
  orgId: string,
  principal: SupportKbSearchPrincipal,
  accessibleSpaceIds: number[],
  vectorLiteral: string,
  limit: number,
): Promise<Array<{ articleId: number; title: string; slug: string | null; similarity: number }>> {
  if (accessibleSpaceIds.length === 0) return [];
  const distance = sql`${kbArticleChunks.embedding} <=> ${vectorLiteral}::vector`;
  const restriction = buildArticleRestrictionBranch(orgId, principal, "view");

  return db
    .select({
      articleId: kbPages.id,
      title: kbPages.title,
      slug: kbPages.slug,
      similarity: sql<number>`(1 - (${distance}))::float8`,
    })
    .from(kbArticleChunks)
    .innerJoin(kbPages, eq(kbPages.id, kbArticleChunks.pageId))
    .innerJoin(
      kbSpaces,
      and(eq(kbSpaces.id, kbPages.spaceId), isNull(kbSpaces.deletedAt)),
    )
    .where(
      and(
        eq(kbArticleChunks.orgId, orgId),
        eq(kbPages.orgId, orgId),
        eq(kbSpaces.orgId, orgId),
        supportArticlePredicate(),
        eq(kbPages.status, "published"),
        inArray(kbPages.spaceId, accessibleSpaceIds),
        restriction,
      ),
    )
    .orderBy(distance)
    .limit(limit);
}

export function listSupportArticles(
  db: Db,
  orgId: string,
  filters: {
    status?: string;
    pageVisibility?: "private" | "org" | "public";
    categoryId?: number;
    search?: string;
  },
) {
  const conditions: SQL[] = [eq(kbPages.orgId, orgId), supportArticlePredicate()];
  if (filters.status) conditions.push(eq(kbPages.status, filters.status));
  if (filters.pageVisibility) conditions.push(eq(kbPages.visibility, filters.pageVisibility));
  if (filters.categoryId) conditions.push(eq(kbPages.categoryId, filters.categoryId));
  if (filters.search) {
    const term = `%${filters.search}%`;
    const match = or(ilike(kbPages.title, term), ilike(kbPages.excerpt, term));
    if (match) conditions.push(match);
  }

  return db
    .select({ ...listProjection, tags: tagNameArray })
    .from(kbPages)
    .where(and(...conditions))
    .orderBy(desc(kbPages.updatedAt))
    .limit(100);
}

export async function lookupSupportArticle(
  db: Db,
  orgId: string,
  articleId: number,
): Promise<{
  id: number;
  orgId: string;
  categoryId: number | null;
  spaceId: number | null;
  title: string;
  slug: string;
  excerpt: string | null;
  content: string;
  contentText: string;
  status: string;
  visibility: ArticleVisibility;
  authorId: string | null;
  ownerMembershipId: number | null;
  views: number;
  helpfulCount: number;
  notHelpfulCount: number;
  seoTitle: string | null;
  seoDescription: string | null;
  reviewIntervalDays: number | null;
  verifiedAt: Date | null;
  publishedAt: Date | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  aclRevision: number;
  contentRevision: number;
} | null> {
  const [row] = await db
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
      visibility: supportArticleVisibility,
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
  return row ?? null;
}

export async function lookupSupportArticleCurrentState(
  db: Db,
  orgId: string,
  articleId: number,
): Promise<{
  id: number;
  slug: string | null;
  status: string;
  publishedAt: Date | null;
  title: string;
  contentText: string | null;
  visibility: string;
  contentRevision: number;
} | null> {
  const [row] = await db
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
  return row ?? null;
}

export async function insertSupportArticle(
  tx: TenantTx,
  values: {
    orgId: string;
    categoryId: number | null | undefined;
    title: string;
    slug: string;
    excerpt: string | null | undefined;
    contentText: string;
    contentType: typeof SUPPORT_ARTICLE_CONTENT_TYPE;
    status: string;
    visibility: string;
    createdById: string;
    publishedAt: Date | null | undefined;
  },
) {
  const [row] = await tx
    .insert(kbPages)
    .values({
      orgId: values.orgId,
      categoryId: values.categoryId ?? null,
      title: values.title,
      slug: values.slug,
      excerpt: values.excerpt ?? null,
      content: articleContentToPageContent(undefined, values.contentText),
      contentText: values.contentText,
      contentType: values.contentType,
      status: values.status,
      visibility: values.visibility,
      createdById: values.createdById,
      publishedAt: values.publishedAt ?? null,
    })
    .returning(listProjection);
  return row;
}

export async function patchSupportArticle(
  tx: TenantTx,
  orgId: string,
  articleId: number,
  values: SupportArticlePatchValues,
  options: {
    bumpContentRevision?: boolean;
    bumpAclRevision?: boolean;
    revisionGuard?: number;
  } = {},
) {
  const [row] = await tx
    .update(kbPages)
    .set({
      ...values,
      ...(values.contentText !== undefined
        ? { content: articleContentToPageContent(undefined, values.contentText) }
        : {}),
      ...(options.bumpContentRevision
        ? { contentRevision: sql<number>`content_revision + 1` }
        : {}),
      ...(options.bumpAclRevision
        ? { aclRevision: sql<number>`acl_revision + 1` }
        : {}),
    })
    .where(
      and(
        eq(kbPages.id, articleId),
        eq(kbPages.orgId, orgId),
        supportArticlePredicate(),
        ...(options.revisionGuard === undefined
          ? []
          : [eq(kbPages.contentRevision, options.revisionGuard)]),
      ),
    )
    .returning(writeProjection);
  return row ?? null;
}

export async function softDeleteSupportArticle(
  db: Db,
  orgId: string,
  articleId: number,
): Promise<number | null> {
  const [row] = await db
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
  return row?.id ?? null;
}

export async function findUsedSupportArticleSlugs(
  db: Db,
  orgId: string,
  root: string,
): Promise<Set<string | null>> {
  const rows = await db
    .select({ slug: kbPages.slug })
    .from(kbPages)
    .where(
      and(
        eq(kbPages.orgId, orgId),
        sql`(${kbPages.slug} = ${root} OR ${kbPages.slug} LIKE ${root + "-%"})`,
      ),
    );
  return new Set(rows.map((r) => r.slug));
}

export async function findSupportArticleSlugConflict(
  db: Db,
  orgId: string,
  slug: string,
  excludeArticleId: number,
): Promise<boolean> {
  const [row] = await db
    .select({ id: kbPages.id })
    .from(kbPages)
    .where(
      and(
        eq(kbPages.orgId, orgId),
        eq(kbPages.slug, slug),
        ne(kbPages.id, excludeArticleId),
        supportArticlePredicate(),
      ),
    )
    .limit(1);
  return row !== undefined;
}
