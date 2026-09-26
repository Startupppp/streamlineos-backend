import { Inject, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { InsufficientAiCreditsException } from "../../../../common/http/api-exceptions";
import { kbEvents } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { AiGatewayService, type EmbedQueryResult } from "../gateway/ai-gateway.service";
import { AiRequestCancelledException } from "./ai-service-exceptions";
import { runInNewTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import {
  hasPublicDocumentContent,
  retrievePublicDocumentChunks,
  type PublicDocumentChunk,
} from "../../../kb/core/kb-rag-documents";

const MIN_DISPLAY_SIMILARITY = 0.2;

export interface KbAnswerSource {
  articleId: number;
  title: string;
  slug: string;
  attachmentId: number | null;
  attachmentName: string | null;
  similarity: number;
}

export interface KbContext {
  sources: KbAnswerSource[];
  system: string;
  userContext: string;
  degraded?: true;
}

function buildKbPrompts(results: PublicDocumentChunk[]): { system: string; user: string } {
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

  async hasPublishedPublicArticles(orgId: string, articleId?: number): Promise<boolean> {
    return hasPublicDocumentContent(this.db, orgId, articleId);
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
    const chunks = await retrievePublicDocumentChunks(
      this.db,
      orgId,
      vector,
      question,
      articleId,
    );
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

  private dedupeSources(
    results: PublicDocumentChunk[],
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
