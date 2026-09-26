import { and, desc, eq, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import {
  kbArticleChunks,
  kbPageAttachments,
  kbPages,
  kbSpaces,
} from "../../../db/schema";
import { publicVisibleDocuments } from "./kb-public-documents";
import { type Db } from "../../../db/drizzle.module";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { PAGE_SIZE_CAP } from "../../../common/pagination/list-query.schema";

const PUBLIC_TOP_K = 6;
const PUBLIC_POOL_K = PUBLIC_TOP_K * 4;

export interface PublicDocumentChunk {
  id: number;
  articleId: number;
  attachmentId: number | null;
  source: string;
  content: string;
  title: string;
  slug: string;
  attachmentName: string | null;
  similarity: number;
}

interface PublicRanking {
  similarity: SQL<number>;
  order: SQL;
  match?: SQL;
}

function publicDocumentChunkScope(
  orgId: string,
  match?: SQL,
  articleId?: number,
): SQL | undefined {
  const conditions: SQL[] = [
    eq(kbArticleChunks.orgId, orgId),
    publicVisibleDocuments(orgId),
    isNotNull(kbPages.slug),
  ];
  if (articleId !== undefined) conditions.push(eq(kbArticleChunks.pageId, articleId));
  if (match !== undefined) conditions.push(match);
  return and(
    ...conditions,
    or(isNull(kbArticleChunks.attachmentId), isNull(kbPageAttachments.deletedAt)),
  );
}

function vectorRanking(vectorLiteral: string): PublicRanking {
  const distance = sql`${kbArticleChunks.embedding} <=> ${vectorLiteral}::vector`;
  return { similarity: sql<number>`(1 - (${distance}))::float8`, order: distance };
}

function lexicalRanking(question: string): PublicRanking {
  const tsquery = sql`websearch_to_tsquery('english', ${question})`;
  const rank = sql`ts_rank(${kbPages.fts}, ${tsquery})`;
  return {
    similarity: sql<number>`(${rank})::float8`,
    order: desc(rank),
    match: sql`${kbPages.fts} @@ ${tsquery}`,
  };
}

export async function hasPublicDocumentContent(
  db: Db,
  orgId: string,
  articleId?: number,
): Promise<boolean> {
  return runInTenantTransaction(
    db,
    async (tx) => {
      const [row] = await tx
        .select({ id: kbArticleChunks.id })
        .from(kbArticleChunks)
        .innerJoin(kbPages, eq(kbPages.id, kbArticleChunks.pageId))
        .innerJoin(kbSpaces, eq(kbPages.spaceId, kbSpaces.id))
        .leftJoin(kbPageAttachments, eq(kbPageAttachments.id, kbArticleChunks.attachmentId))
        .where(publicDocumentChunkScope(orgId, undefined, articleId))
        .limit(1);
      return Boolean(row);
    },
    { orgId },
  );
}

export async function retrievePublicDocumentChunks(
  db: Db,
  orgId: string,
  vectorLiteral: string | null,
  question: string,
  articleId?: number,
): Promise<PublicDocumentChunk[]> {
  const ranking =
    vectorLiteral === null ? lexicalRanking(question) : vectorRanking(vectorLiteral);
  return runInTenantTransaction(
    db,
    async (tx) => {
      const pool = await tx
        .select({
          id: kbArticleChunks.id,
          articleId: kbPages.id,
          attachmentId: kbArticleChunks.attachmentId,
          source: kbArticleChunks.source,
          content: kbArticleChunks.content,
          title: kbPages.title,
          slug: kbPages.slug,
          attachmentName: kbPageAttachments.fileName,
          similarity: ranking.similarity,
        })
        .from(kbArticleChunks)
        .innerJoin(kbPages, eq(kbPages.id, kbArticleChunks.pageId))
        .innerJoin(kbSpaces, eq(kbPages.spaceId, kbSpaces.id))
        .leftJoin(kbPageAttachments, eq(kbPageAttachments.id, kbArticleChunks.attachmentId))
        .where(publicDocumentChunkScope(orgId, ranking.match, articleId))
        .orderBy(ranking.order)
        .limit(Math.min(PUBLIC_POOL_K, PAGE_SIZE_CAP));

      return pool
        .flatMap((row) => (row.slug === null ? [] : [{ ...row, slug: row.slug }]))
        .slice(0, PUBLIC_TOP_K);
    },
    { orgId },
  );
}
