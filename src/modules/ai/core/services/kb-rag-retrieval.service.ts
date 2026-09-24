import { Inject, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { InsufficientAiCreditsException } from "../../../../common/http/api-exceptions";
import { and, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import {
  kbArticleChunks,
  kbEvents,
  kbPageAttachments,
  kbPages,
  kbSpaces,
} from "../../../../db/schema";
import { supportArticlePredicate } from "../../../kb/help-centre/kb-article-page-scope";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { AiGatewayService, type EmbedQueryResult } from "../gateway/ai-gateway.service";
import { PAGE_SIZE_CAP } from "../../../../common/pagination/list-query.schema";
import { AiRequestCancelledException } from "./ai-service-exceptions";
import {
  runInTenantTransaction,
  runInNewTenantTransaction,
} from "../../../../common/tenant/run-in-tenant-transaction";

const DEFAULT_TOP_K = 6;
const SEARCH_POOL_K = DEFAULT_TOP_K * 4;
const MIN_DISPLAY_SIMILARITY = 0.2;

export interface KbAnswerSource {
  articleId: number;
  title: string;
  slug: string;
  attachmentId: number | null;
  attachmentName: string | null;
  similarity: number;
}

interface KbSearchResult {
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

export interface KbContext {
  sources: KbAnswerSource[];
  system: string;
  userContext: string;
  degraded?: true;
}

interface KbChunkRanking {
  similarity: SQL<number>;
  order: SQL;
  match?: SQL;
}

function buildKbPrompts(results: KbSearchResult[]): { system: string; user: string } {
  const context = results
    .map(
      (r, i) =>
        `[${i + 1}] ${r.title}${r.attachmentName ? ` — ${r.attachmentName}` : ""}\n${r.content}`,
    )
    .join("\n\n---\n\n");

  return {
    system:
      "You are a knowledge base assistant. Answer the user's question using ONLY the provided context excerpts. " +
      "Be concise and accurate. Cite supporting excerpts inline using their bracket number, e.g. [1]. " +
      "If the context does not contain the answer, clearly say you don't have that information in the knowledge base. " +
      "Never invent facts that are not in the context.",
    user: context,
  };
}

function vectorRanking(vector: string): KbChunkRanking {
  const distance = sql`${kbArticleChunks.embedding} <=> ${vector}::vector`;
  return { similarity: sql<number>`(1 - (${distance}))::float8`, order: distance };
}

function lexicalRanking(question: string): KbChunkRanking {
  const tsquery = sql`websearch_to_tsquery('english', ${question})`;
  const rank = sql`ts_rank(${kbPages.fts}, ${tsquery})`;
  return {
    similarity: sql<number>`(${rank})::float8`,
    order: desc(rank),
    match: sql`${kbPages.fts} @@ ${tsquery}`,
  };
}

@Injectable()
export class KbRagRetrievalService {
  private readonly logger = new Logger(KbRagRetrievalService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly aiGateway: AiGatewayService,
  ) {}

  isEmbeddingConfigured(): boolean {
    return this.aiGateway.isEmbeddingConfigured();
  }

  async hasPublishedPublicArticles(orgId: string): Promise<boolean> {
    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const [row] = await tx
          .select({ id: kbPages.id })
          .from(kbPages)
          .innerJoin(kbSpaces, eq(kbPages.spaceId, kbSpaces.id))
          .where(
            and(
              eq(kbPages.orgId, orgId),
              eq(kbPages.status, "published"),
              eq(kbPages.visibility, "public"),
              supportArticlePredicate(),
              inArray(kbSpaces.audience, ["public", "mixed"]),
              isNull(kbSpaces.deletedAt),
            ),
          )
          .limit(1);
        return Boolean(row);
      },
      { orgId },
    );
  }

  recordNoContext(orgId: string, question: string): void {
    void runInNewTenantTransaction(this.db, orgId, async (tx) => {
      await tx.insert(kbEvents).values({
        orgId,
        eventType: "ai_answer_no_context",
        query: question,
      });
    }).catch((err: unknown) => {
      this.logger.warn(`Failed to record ai_answer_no_context event: ${err}`);
    });
  }

  async retrieveContext(
    orgId: string,
    question: string,
    articleId?: number,
    signal?: AbortSignal,
  ): Promise<KbContext | null> {
    const vector = await this.embedQuestion(question, orgId, signal);
    signal?.throwIfAborted();
    const ranking = vector === null ? lexicalRanking(question) : vectorRanking(vector);
    const chunks = await this.fetchChunks(orgId, ranking, articleId);
    if (chunks.length === 0) return null;
    const sources = this.dedupeSources(chunks, vector !== null);
    const { system, user: userContext } = buildKbPrompts(chunks);
    return {
      sources,
      system,
      userContext,
      ...(vector === null ? { degraded: true as const } : {}),
    };
  }

  private async embedQuestion(
    text: string,
    orgId: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    let embedResult: EmbedQueryResult;
    try {
      embedResult = await this.aiGateway.embedQueryWithCredit({
        text,
        orgId,
        feature: "kb.public-embedding",
        charge: true,
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch (err: unknown) {
      this.logger.warn("KB public embedding threw — lexical retrieval only", {
        orgId,
        error: err instanceof Error ? err.name : typeof err,
      });
      return null;
    }
    if (!embedResult.ok) {
      if (embedResult.kind === "quota_exceeded")
        throw new InsufficientAiCreditsException({ message: embedResult.message });
      if (embedResult.kind === "concurrency_exceeded")
        throw new ServiceUnavailableException(embedResult.message);
      if (embedResult.kind === "cancelled")
        throw new AiRequestCancelledException(embedResult.message);
      this.logger.warn("KB public embedding unavailable — lexical retrieval only", {
        orgId,
        kind: embedResult.kind,
      });
      return null;
    }
    return embedResult.vectorLiteral;
  }

  private async fetchChunks(
    orgId: string,
    ranking: KbChunkRanking,
    articleId?: number,
  ): Promise<KbSearchResult[]> {
    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const conditions: SQL[] = [
          eq(kbArticleChunks.orgId, orgId),
          eq(kbPages.status, "published"),
          eq(kbPages.visibility, "public"),
          supportArticlePredicate(),
          isNotNull(kbPages.slug),
          inArray(kbSpaces.audience, ["public", "mixed"]),
          isNull(kbSpaces.deletedAt),
        ];
        if (articleId !== undefined) conditions.push(eq(kbArticleChunks.pageId, articleId));
        if (ranking.match !== undefined) conditions.push(ranking.match);

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
          .where(and(...conditions))
          .orderBy(ranking.order)
          .limit(Math.min(SEARCH_POOL_K, PAGE_SIZE_CAP));

        return pool
          .flatMap((row) => (row.slug === null ? [] : [{ ...row, slug: row.slug }]))
          .slice(0, DEFAULT_TOP_K);
      },
      { orgId },
    );
  }

  private dedupeSources(
    results: KbSearchResult[],
    applySimilarityFloor: boolean,
  ): KbAnswerSource[] {
    const seen = new Set<string>();
    const sources: KbAnswerSource[] = [];
    for (const r of results) {
      if (applySimilarityFloor && r.similarity < MIN_DISPLAY_SIMILARITY) continue;
      const key = `${r.articleId}:${r.attachmentId ?? "body"}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push({
        articleId: r.articleId,
        title: r.title,
        slug: r.slug,
        attachmentId: r.attachmentId,
        attachmentName: r.attachmentName,
        similarity: r.similarity,
      });
    }
    return sources;
  }
}
