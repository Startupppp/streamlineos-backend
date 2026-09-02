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
import { AI_CREDIT_LEDGER, type AiCreditLedger } from "../gateway/credit-ledger.interface";
import { AiUsageService } from "./ai-usage.service";
import { settleStream } from "../gateway/ai-gateway-credit.helper";
import { getReserveEstimateMilli } from "../billing/ai-cost-catalog";
import { streamText, type ToolSet } from "ai";
import { resolveChatModel, resolveChatModelId } from "./chat-assistant-model";
import { logger } from "../../../../common/logger/logger.service";
import {
  runInTenantTransaction,
  runInNewTenantTransaction,
} from "../../../../common/tenant/run-in-tenant-transaction";

const DEFAULT_TOP_K = 6;
const SEARCH_POOL_K = DEFAULT_TOP_K * 4;
const MIN_DISPLAY_SIMILARITY = 0.2;
const KB_RAG_STREAM_FEATURE = "kb.public-ask";
const KB_NO_CONTEXT_ANSWER = "I couldn't find anything related to that in the knowledge base yet.";

export interface KbAnswerSource {
  articleId: number;
  title: string;
  slug: string;
  attachmentId: number | null;
  attachmentName: string | null;
  similarity: number;
}

export interface KbAnswer {
  answer: string;
  sources: KbAnswerSource[];
  hasContext: boolean;
}

export type KbStreamAnswer =
  | { hasContext: false; answer: string; sources: KbAnswerSource[] }
  | {
      hasContext: true;
      stream: ReturnType<typeof streamText<ToolSet>>;
      sources: KbAnswerSource[];
    };

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

interface AnswerOptions {
  orgId: string;
  question: string;
  articleId?: number;
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

@Injectable()
export class KbRagService {
  private readonly logger = new Logger(KbRagService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly aiGateway: AiGatewayService,
    @Inject(AI_CREDIT_LEDGER) private readonly ledger: AiCreditLedger,
    private readonly usageSvc: AiUsageService,
  ) {}

  isEmbeddingConfigured(): boolean {
    return this.aiGateway.isEmbeddingConfigured();
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

  private async hasPublishedPublicArticles(orgId: string): Promise<boolean> {
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

  private recordNoContext(orgId: string, question: string): void {
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

  private async embedQuestion(opts: AnswerOptions): Promise<string | null> {
    const embedResult = await this.aiGateway.embedQueryWithCredit({
      text: opts.question,
      orgId: opts.orgId,
      feature: "kb.public-embedding",
      charge: true,
    });
    if (!embedResult.ok) {
      if (embedResult.kind === "quota_exceeded")
        throw new InsufficientAiCreditsException({ message: embedResult.message });
      throw new ServiceUnavailableException("AI provider is temporarily unavailable");
    }
    return embedResult.vectorLiteral;
  }

  private async runAnswer(opts: AnswerOptions): Promise<KbAnswer> {
    const vectorLiteral = await this.embedQuestion(opts);
    if (vectorLiteral === null) {
      this.recordNoContext(opts.orgId, opts.question);
      return { answer: KB_NO_CONTEXT_ANSWER, sources: [], hasContext: false };
    }

    const results = await this.fetchChunks(opts.orgId, vectorLiteral, opts.articleId);

    if (results.length === 0) {
      this.recordNoContext(opts.orgId, opts.question);
      return {
        answer: KB_NO_CONTEXT_ANSWER,
        sources: [],
        hasContext: false,
      };
    }

    const { system, user: contextUser } = buildKbPrompts(results);
    const userMessage = `${contextUser}\n\nQuestion: ${opts.question}`;

    const gatewayResult = await this.aiGateway.invokeText({
      actor: { orgId: opts.orgId, userId: null },
      feature: "kb.public-ask",
      tier: "fast",
      maxTokens: 1024,
      charge: true,
      prompt: { system, user: userMessage },
    });

    if (!gatewayResult.ok) {
      if (gatewayResult.kind === "quota_exceeded")
        throw new InsufficientAiCreditsException({ message: gatewayResult.message });
      throw new ServiceUnavailableException("AI provider is temporarily unavailable");
    }

    return {
      answer: gatewayResult.data.trim(),
      sources: this.dedupeSources(results),
      hasContext: true,
    };
  }

  async answerQuestion(opts: AnswerOptions): Promise<KbAnswer> {
    const hasArticles = await this.hasPublishedPublicArticles(opts.orgId);
    if (!hasArticles) {
      this.recordNoContext(opts.orgId, opts.question);
      return {
        answer: KB_NO_CONTEXT_ANSWER,
        sources: [],
        hasContext: false,
      };
    }
    return this.runAnswer(opts);
  }

  async streamAnswer(opts: AnswerOptions, signal?: AbortSignal): Promise<KbStreamAnswer> {
    const hasArticles = await this.hasPublishedPublicArticles(opts.orgId);
    if (!hasArticles) {
      this.recordNoContext(opts.orgId, opts.question);
      return { hasContext: false, answer: KB_NO_CONTEXT_ANSWER, sources: [] };
    }

    const vectorLiteral = await this.embedQuestion(opts);
    if (vectorLiteral === null) {
      this.recordNoContext(opts.orgId, opts.question);
      return { hasContext: false, answer: KB_NO_CONTEXT_ANSWER, sources: [] };
    }

    const results = await this.fetchChunks(opts.orgId, vectorLiteral, opts.articleId);

    if (results.length === 0) {
      this.recordNoContext(opts.orgId, opts.question);
      return { hasContext: false, answer: KB_NO_CONTEXT_ANSWER, sources: [] };
    }

    const sources = this.dedupeSources(results);
    const { system, user: contextUser } = buildKbPrompts(results);
    const userMessage = `${contextUser}\n\nQuestion: ${opts.question}`;

    const reserveMilli = getReserveEstimateMilli(KB_RAG_STREAM_FEATURE);
    const { reservationId } = await this.ledger.reserve({
      orgId: opts.orgId,
      userId: null,
      feature: KB_RAG_STREAM_FEATURE,
      credits: reserveMilli,
    });

    let resolved = false;
    const releaseReservation = (reason: string) => {
      if (resolved) return;
      resolved = true;
      void this.ledger.release(reservationId, reason, opts.orgId).catch(() => undefined);
    };

    const modelId = resolveChatModelId();

    const stream = streamText({
      model: resolveChatModel(),
      messages: [{ role: "user", content: userMessage }],
      system,
      maxOutputTokens: 1024,
      maxRetries: 0,
      ...(signal !== undefined ? { abortSignal: signal } : {}),
      onError: ({ error }) => {
        if (signal?.aborted === true || isAbortError(error)) return;
        logger.warn("KB RAG stream failed", {
          error: error instanceof Error ? error.message : String(error),
          orgId: opts.orgId,
        });
      },
      onFinish: async ({ usage }) => {
        if (resolved) return;
        resolved = true;
        const promptTokens = usage?.inputTokens ?? 0;
        const completionTokens = usage?.outputTokens ?? 0;
        try {
          await settleStream(this.ledger, this.usageSvc, {
            reservationId,
            model: modelId,
            promptTokens,
            completionTokens,
            orgId: opts.orgId,
            userId: null,
            feature: KB_RAG_STREAM_FEATURE,
          });
        } catch (err) {
          logger.error("Failed to settle KB RAG stream", {
            error: err instanceof Error ? (err.stack ?? err.message) : String(err),
            orgId: opts.orgId,
            reservationId,
          });
        }
      },
    });

    void Promise.resolve(stream.finishReason).catch(() =>
      releaseReservation("stream_aborted_no_settle"),
    );

    return { stream, sources, hasContext: true };
  }
}
