import { Inject, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { InsufficientAiCreditsException } from "../../../../common/http/api-exceptions";
import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import {
  kbArticleAttachments,
  kbArticleChunks,
  kbArticles,
  kbEvents,
  kbSpaces,
} from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { AiGatewayService } from "../gateway/ai-gateway.service";
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
          .select({ id: kbArticles.id })
          .from(kbArticles)
          .innerJoin(kbSpaces, eq(kbArticles.spaceId, kbSpaces.id))
          .where(
            and(
              eq(kbArticles.orgId, orgId),
              eq(kbArticles.status, "published"),
              eq(kbArticles.visibility, "public"),
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
  ): Promise<KbContext | null> {
    const vector = await this.embedQuestion(question, orgId);
    if (vector === null) return null;
    const chunks = await this.fetchChunks(orgId, vector, articleId);
    if (chunks.length === 0) return null;
    const sources = this.dedupeSources(chunks);
    const { system, user: userContext } = buildKbPrompts(chunks);
    return { sources, system, userContext };
  }

  private async embedQuestion(text: string, orgId: string): Promise<string | null> {
    const embedResult = await this.aiGateway.embedQueryWithCredit({
      text,
      orgId,
      feature: "kb.public-embedding",
      charge: true,
    });
    if (!embedResult.ok) {
      if (embedResult.kind === "quota_exceeded")
        throw new InsufficientAiCreditsException({ message: embedResult.message });
      if (embedResult.kind === "concurrency_exceeded")
        throw new ServiceUnavailableException(embedResult.message);
      throw new ServiceUnavailableException("AI provider is temporarily unavailable");
    }
    return embedResult.vectorLiteral;
  }

  private async fetchChunks(
    orgId: string,
    vector: string,
    articleId?: number,
  ): Promise<KbSearchResult[]> {
    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const distance = sql`${kbArticleChunks.embedding} <=> ${vector}::vector`;
        const conditions: SQL[] = [
          eq(kbArticleChunks.orgId, orgId),
          eq(kbArticles.status, "published"),
          eq(kbArticles.visibility, "public"),
          inArray(kbSpaces.audience, ["public", "mixed"]),
          isNull(kbSpaces.deletedAt),
        ];
        if (articleId !== undefined) conditions.push(eq(kbArticleChunks.articleId, articleId));

        const pool = await tx
          .select({
            id: kbArticleChunks.id,
            articleId: kbArticles.id,
            attachmentId: kbArticleChunks.attachmentId,
            source: kbArticleChunks.source,
            content: kbArticleChunks.content,
            title: kbArticles.title,
            slug: kbArticles.slug,
            attachmentName: kbArticleAttachments.fileName,
            similarity: sql<number>`(1 - (${distance}))::float8`,
          })
          .from(kbArticleChunks)
          .innerJoin(kbArticles, eq(kbArticles.id, kbArticleChunks.articleId))
          .innerJoin(kbSpaces, eq(kbArticles.spaceId, kbSpaces.id))
          .leftJoin(kbArticleAttachments, eq(kbArticleAttachments.id, kbArticleChunks.attachmentId))
          .where(and(...conditions))
          .orderBy(distance)
          .limit(SEARCH_POOL_K);

        return pool.slice(0, DEFAULT_TOP_K);
      },
      { orgId },
    );
  }

  private dedupeSources(results: KbSearchResult[]): KbAnswerSource[] {
    const seen = new Set<string>();
    const sources: KbAnswerSource[] = [];
    for (const r of results) {
      if (r.similarity < MIN_DISPLAY_SIMILARITY) continue;
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
