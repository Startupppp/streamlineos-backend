import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { kbCategories, kbPages, kbSpaces } from "../../../db/schema";
import { SUPPORT_ARTICLE_CONTENT_TYPE } from "../help-centre/kb-article-page-scope";
import { PAGE_SIZE_CAP } from "../../../common/pagination/list-query.schema";
import { keysetBeforeId } from "../../../common/pagination/keyset";
import type { CursorPosition } from "../../../common/pagination/cursor";
import type { Db } from "../../../db/drizzle.types";
import type { TenantTx } from "../../../db/drizzle.types";

export interface PublicDocumentSummary {
  id: number;
  categoryId: number | null;
  title: string;
  slug: string;
  excerpt: string | null;
  views: number | null;
  helpfulCount: number | null;
  notHelpfulCount: number | null;
  tags: string[];
  publishedAt: Date | null;
}

export interface PublicDocumentDetail {
  id: number;
  title: string;
  slug: string;
  excerpt: string | null;
  content: string | null;
  categoryId: number | null;
  categoryName: string | null;
  categorySlug: string | null;
  views: number | null;
  helpfulCount: number | null;
  notHelpfulCount: number | null;
  tags: string[];
  seoTitle: string | null;
  seoDescription: string | null;
  publishedAt: Date | null;
  updatedAt: Date | null;
}

export interface PublicDocumentListParams {
  categoryId?: number;
  search?: string;
  position?: CursorPosition;
  pageSize: number;
}

const articleTagNames = sql<string[]>`ARRAY(
  SELECT kt.name FROM kb_page_tags kpt
  JOIN kb_tags kt ON kt.id = kpt.tag_id
  WHERE kpt.page_id = ${kbPages.id}
  ORDER BY kt.name
)`;

export function publicVisibleDocuments(orgId: string): SQL {
  return (
    and(
      eq(kbPages.orgId, orgId),
      eq(kbPages.contentType, SUPPORT_ARTICLE_CONTENT_TYPE),
      isNull(kbPages.deletedAt),
      eq(kbPages.status, "published"),
      eq(kbPages.visibility, "public"),
      inArray(kbSpaces.audience, ["public", "mixed"]),
      isNull(kbSpaces.deletedAt),
    ) ?? sql`false`
  );
}

export async function listPublicDocuments(
  db: Db,
  orgId: string,
  params: PublicDocumentListParams,
): Promise<PublicDocumentSummary[]> {
  const pageSize = Math.min(params.pageSize, PAGE_SIZE_CAP);
  const searchMatch = params.search
    ? or(
        ilike(kbPages.title, `%${params.search}%`),
        ilike(kbPages.excerpt, `%${params.search}%`),
      )
    : undefined;
  return db
    .select({
      id: kbPages.id,
      categoryId: kbPages.categoryId,
      title: kbPages.title,
      slug: kbPages.slug,
      excerpt: kbPages.excerpt,
      views: kbPages.views,
      helpfulCount: kbPages.helpfulCount,
      notHelpfulCount: kbPages.notHelpfulCount,
      tags: articleTagNames,
      publishedAt: kbPages.publishedAt,
    })
    .from(kbPages)
    .innerJoin(kbSpaces, eq(kbPages.spaceId, kbSpaces.id))
    .where(
      and(
        publicVisibleDocuments(orgId),
        params.categoryId !== undefined
          ? eq(kbPages.categoryId, params.categoryId)
          : undefined,
        searchMatch,
        params.position !== undefined
          ? keysetBeforeId(kbPages.publishedAt, kbPages.id, params.position)
          : undefined,
      ),
    )
    .orderBy(desc(kbPages.publishedAt), desc(kbPages.id))
    .limit(pageSize + 1);
}

export async function findPublicDocumentBySlug(
  db: Db,
  orgId: string,
  slug: string,
): Promise<PublicDocumentDetail | null> {
  const [row] = await db
    .select({
      id: kbPages.id,
      title: kbPages.title,
      slug: kbPages.slug,
      excerpt: kbPages.excerpt,
      content: kbPages.contentText,
      categoryId: kbPages.categoryId,
      categoryName: kbCategories.name,
      categorySlug: kbCategories.slug,
      views: kbPages.views,
      helpfulCount: kbPages.helpfulCount,
      notHelpfulCount: kbPages.notHelpfulCount,
      tags: articleTagNames,
      seoTitle: kbPages.seoTitle,
      seoDescription: kbPages.seoDescription,
      publishedAt: kbPages.publishedAt,
      updatedAt: kbPages.updatedAt,
    })
    .from(kbPages)
    .leftJoin(kbCategories, eq(kbPages.categoryId, kbCategories.id))
    .innerJoin(kbSpaces, eq(kbPages.spaceId, kbSpaces.id))
    .where(and(publicVisibleDocuments(orgId), eq(kbPages.slug, slug)));
  return row ?? null;
}

export async function findPublicDocumentIdBySlug(
  db: Db,
  orgId: string,
  slug: string,
): Promise<{ id: number } | null> {
  const [row] = await db
    .select({ id: kbPages.id })
    .from(kbPages)
    .innerJoin(kbSpaces, eq(kbPages.spaceId, kbSpaces.id))
    .where(and(publicVisibleDocuments(orgId), eq(kbPages.slug, slug)));
  return row ?? null;
}

export async function incrementPublicDocumentView(
  db: Db,
  orgId: string,
  documentId: number,
): Promise<void> {
  await db
    .update(kbPages)
    .set({ views: sql`coalesce(${kbPages.views}, 0) + 1` })
    .where(and(eq(kbPages.orgId, orgId), eq(kbPages.id, documentId)));
}

export async function adjustPublicDocumentFeedback(
  tx: TenantTx,
  orgId: string,
  documentId: number,
  helpful: boolean,
): Promise<void> {
  await tx
    .update(kbPages)
    .set(
      helpful
        ? { helpfulCount: sql`coalesce(${kbPages.helpfulCount}, 0) + 1` }
        : { notHelpfulCount: sql`coalesce(${kbPages.notHelpfulCount}, 0) + 1` },
    )
    .where(and(eq(kbPages.orgId, orgId), eq(kbPages.id, documentId)));
}
