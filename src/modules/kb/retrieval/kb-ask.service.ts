import { HttpException, HttpStatus, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Redis } from "@upstash/redis";
import { InsufficientAiCreditsException } from "../../../common/http/api-exceptions";
import { REDIS } from "../../../common/cache/cache.service";
import { KbAskMetrics } from "../core/telemetry/kb-ask-metrics";
import { KbEventsService } from "../core/kb-events.service";
import { KbSearchService } from "./kb-search.service";
import { KbCitationVisibilityService } from "./kb-citation-visibility.service";
import {
  KbLinkedDocumentAskSource,
  type LinkedDocumentCitation,
} from "../linked-documents/kb-linked-document-ask-source";
import type { LinkedDocumentItem } from "../linked-documents/dto/kb-linked-documents-response.schemas";
import {
  AiGatewayService,
  type AiTextStream,
} from "../../ai/core/gateway/ai-gateway.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";
import type { AskInput } from "./dto/kb-ai.schemas";
import type { AiUsageMeta } from "../../ai/core/gateway/ai-gateway.types";
import {
  ASK_SYSTEM_PROMPT,
  assemblePassages,
  buildKbContext,
  KB_ASK_MAX_CONTEXT_DOCUMENTS,
} from "./kb-ask-context";
import { kbAiInteractions, type KbAiInteractionState, type KbAiSourceRecord } from "../../../db/schema";

export const KB_ASK_ORG_LIMIT = 200;
const KB_ASK_ORG_WINDOW_SECS = 60;

export type AskCitation =
  | {
      kind: "article";
      articleId: number;
      title: string;
      slug: string;
      spaceId: number | null;
      updatedAt: Date;
    }
  | {
      kind: "page";
      pageId: number;
      title: string;
      spaceId: number | null;
      updatedAt: Date;
    }
  | {
      kind: "source";
      sourceId: number;
      title: string;
      spaceId: number | null;
      updatedAt: Date;
    }
  | LinkedDocumentCitation;

export function restrictToCited<
  TTop extends { kind: "article" | "page"; id: number },
  TSource extends { sourceId: number },
>(
  top: TTop[],
  sources: TSource[],
  citations: AskCitation[],
): { top: TTop[]; sources: TSource[] } {
  const citedArticles = new Set<number>();
  const citedPages = new Set<number>();
  const citedSources = new Set<number>();
  for (const citation of citations) {
    if (citation.kind === "article") citedArticles.add(citation.articleId);
    else if (citation.kind === "page") citedPages.add(citation.pageId);
    else if (citation.kind === "source") citedSources.add(citation.sourceId);
  }
  return {
    top: top.filter((item) =>
      item.kind === "article"
        ? citedArticles.has(item.id)
        : citedPages.has(item.id),
    ),
    sources: sources.filter((item) => citedSources.has(item.sourceId)),
  };
}

export interface KbAskOptions {
  companyDocuments?: boolean;
}

function buildSourceRecords(
  top: ReadonlyArray<{ kind: "article" | "page"; id: number }>,
  sources: ReadonlyArray<{ sourceId: number }>,
  linked: ReadonlyArray<{ id: number }>,
): KbAiSourceRecord[] {
  const records: KbAiSourceRecord[] = [];
  for (const item of top) {
    records.push({ kind: item.kind, id: item.id, aclRevision: null });
  }
  for (const s of sources) {
    records.push({ kind: "source", id: s.sourceId, aclRevision: null });
  }
  for (const doc of linked) {
    records.push({ kind: "document", id: doc.id, aclRevision: null });
  }
  return records;
}

@Injectable()
export class KbAskService {
  private readonly logger = new Logger(KbAskService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly aiGateway: AiGatewayService,
    private readonly events: KbEventsService,
    private readonly search: KbSearchService,
    private readonly citationVisibility: KbCitationVisibilityService,
    private readonly linkedDocuments: KbLinkedDocumentAskSource,
    @Inject(REDIS) private readonly redis: Redis | null,
  ) {}

  private async gatherContext(
    user: CurrentUserContext,
    input: AskInput,
    options: KbAskOptions,
  ): Promise<
    | { kind: "no-context" }
    | {
        kind: "context";
        fullContext: string;
        top: Awaited<ReturnType<KbSearchService["retrieveTopArticles"]>>;
        sources: Awaited<ReturnType<KbSearchService["retrieveTopSources"]>>;
        linked: LinkedDocumentItem[];
        citations: AskCitation[];
        degraded: boolean;
      }
  > {
    return runInTenantTransaction(
      this.db,
      async () => {
        const linked =
          options.companyDocuments === true
            ? await this.linkedDocuments.retrieve(user, input.question)
            : [];
        const hasContent = await this.orgHasIndexedContent(user.orgId);
        if (!hasContent && linked.length === 0) return { kind: "no-context" as const };

        const retrievedTop = hasContent
          ? await this.search.retrieveTopArticles(
              user,
              input.question,
              KB_ASK_MAX_CONTEXT_DOCUMENTS,
              input.spaceId,
              input.verifiedOnly,
            )
          : [];
        const retrievedSources = hasContent
          ? await this.search.retrieveTopSources(user, input.question, 4)
          : [];
        if (
          retrievedTop.length === 0 &&
          retrievedSources.length === 0 &&
          linked.length === 0
        )
          return { kind: "no-context" as const };

        const citations = [
          ...(await this.resolveCitations(user, retrievedTop, retrievedSources)),
          ...linked.map((document) => this.linkedDocuments.citationOf(document)),
        ];
        if (citations.length === 0) return { kind: "no-context" as const };

        const { top, sources } = restrictToCited(
          retrievedTop,
          retrievedSources,
          citations,
        );

        const articleIds = top
          .filter((source) => source.kind === "article")
          .map((source) => source.id);
        const pageIds = top
          .filter((source) => source.kind === "page")
          .map((source) => source.id);
        const documentPassages = hasContent
          ? await this.search.retrieveDocumentPassages(
              user,
              input.question,
              articleIds,
              pageIds,
            )
          : [];

        const fullContext = buildKbContext(
          assemblePassages(
            top,
            sources,
            documentPassages,
            linked.map((document) => this.linkedDocuments.passageOf(document)),
          ),
        );
        if (fullContext.length === 0) return { kind: "no-context" as const };

        const degraded =
          sources.some((source) => source.degraded === true) ||
          documentPassages.some((passage) => passage.degraded === true);

        return {
          kind: "context" as const,
          fullContext,
          top,
          sources,
          linked,
          citations,
          degraded,
        };
      },
      { orgId: user.orgId },
    );
  }

  private noContextAnswer(
    user: CurrentUserContext,
    question: string,
    correlationId: string,
  ): { answer: string; citations: AskCitation[]; hasContext: boolean } {
    this.events
      .record(user.orgId, "ai_answer_no_context", {
        actorMembershipId: actingMembershipId(user.principal) ?? null,
        query: question,
        correlationId,
      })
      .catch((err: unknown) => {
        this.logger.warn(`Failed to record ai_answer_no_context event: ${err}`);
      });
    return {
      answer:
        "I couldn't find anything about that in the knowledge base. You may want to open a support ticket.",
      citations: [],
      hasContext: false,
    };
  }

  private async writeNoContextInteraction(
    user: CurrentUserContext,
    correlationId: string,
  ): Promise<void> {
    await runInTenantTransaction(
      this.db,
      async (tx) => {
        await tx.insert(kbAiInteractions).values({
          orgId: user.orgId,
          correlationId,
          actorMembershipId: actingMembershipId(user.principal) ?? null,
          resultState: "no_context",
          sourceIdsWithRevisions: [],
        });
      },
      { orgId: user.orgId },
    ).catch((err: unknown) => {
      this.logger.warn(`Failed to write no-context interaction row: ${err}`);
    });
  }

  async ask(
    user: CurrentUserContext,
    input: AskInput,
    options: KbAskOptions = {},
  ): Promise<{
    answer: string;
    citations: AskCitation[];
    hasContext: boolean;
    aiUsage?: AiUsageMeta;
  }> {
    const correlationId = randomUUID();
    if (this.redis) {
      const orgKey = `rl:kb:ask:org:${user.orgId}`;
      const count = await this.redis.incr(orgKey);
      if (count === 1) await this.redis.expire(orgKey, KB_ASK_ORG_WINDOW_SECS);
      if (count > KB_ASK_ORG_LIMIT) {
        const ttl = await this.redis.ttl(orgKey);
        throw new HttpException(
          { message: "Org Ask rate limit exceeded", retryAfterSecs: ttl > 0 ? ttl : KB_ASK_ORG_WINDOW_SECS },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
    const metrics = KbAskMetrics.begin({ orgId: user.orgId });
    try {
      const gathered = await this.gatherContext(user, input, options);
      if (gathered.kind === "no-context") {
        metrics.finish("no_context");
        void this.writeNoContextInteraction(user, correlationId);
        return this.noContextAnswer(user, input.question, correlationId);
      }
      const { fullContext, top, sources, linked, citations, degraded } = gathered;
      const candidates = top.length + sources.length + linked.length;
      const sourceIdsWithRevisions = buildSourceRecords(top, sources, linked);

      const callStart = Date.now();
      const gatewayResult = await this.aiGateway.invokeTextWithUsage({
        actor: { orgId: user.orgId, userId: user.userId },
        feature: "kb.ask",
        tier: "fast",
        maxTokens: 1024,
        charge: true,
        prompt: {
          system: ASK_SYSTEM_PROMPT,
          user: `Question: ${input.question}\n\nContext:\n${fullContext}`,
        },
      });
      const latencyMs = Date.now() - callStart;

      if (!gatewayResult.ok) {
        if (gatewayResult.kind === "quota_exceeded") {
          metrics.finish("credits_exhausted", {
            citations: citations.length,
            candidates,
          });
          await runInTenantTransaction(
            this.db,
            async (tx) => {
              await tx.insert(kbAiInteractions).values({
                orgId: user.orgId,
                correlationId,
                actorMembershipId: actingMembershipId(user.principal) ?? null,
                resultState: "credits_exhausted",
                sourceIdsWithRevisions,
                latencyMs,
                gatewayCorrelationId: gatewayResult.correlationId,
              });
            },
            { orgId: user.orgId },
          );
          throw new InsufficientAiCreditsException({
            message: gatewayResult.message,
          });
        }
        metrics.finish("provider_unavailable", {
          citations: citations.length,
          candidates,
        });
        await runInTenantTransaction(
          this.db,
          async (tx) => {
            await tx.insert(kbAiInteractions).values({
              orgId: user.orgId,
              correlationId,
              actorMembershipId: actingMembershipId(user.principal) ?? null,
              resultState: "provider_unavailable",
              sourceIdsWithRevisions,
              latencyMs,
              gatewayCorrelationId: gatewayResult.correlationId,
            });
          },
          { orgId: user.orgId },
        );
        return {
          answer:
            "The AI assistant is temporarily unavailable. Here are the most relevant sources found for your question.",
          citations,
          hasContext: true,
        };
      }

      const answer = gatewayResult.data;
      const aiUsage = gatewayResult.aiUsage;

      await runInTenantTransaction(
        this.db,
        async (tx) => {
          await tx.insert(kbAiInteractions).values({
            orgId: user.orgId,
            correlationId,
            actorMembershipId: actingMembershipId(user.principal) ?? null,
            resultState: "answered",
            model: aiUsage.model,
            promptTokens: aiUsage.promptTokens,
            completionTokens: aiUsage.completionTokens,
            totalTokens: aiUsage.totalTokens,
            costCredits: aiUsage.credits,
            latencyMs,
            gatewayCorrelationId: gatewayResult.correlationId,
            sourceIdsWithRevisions,
          });
          await this.events.record(user.orgId, "ai_answer", {
            actorMembershipId: actingMembershipId(user.principal) ?? null,
            query: input.question,
            metadata: {
              sourceIds: [
                ...top.map((s) => `${s.kind}:${s.id}`),
                ...linked.map((document) => `document:${document.id}`),
              ],
            },
            correlationId,
          });
        },
        { orgId: user.orgId },
      );

      metrics.finish(degraded ? "degraded" : "answered", {
        citations: citations.length,
        candidates,
        degraded,
      });
      return { answer, citations, hasContext: true, aiUsage };
    } catch (error) {
      metrics.finish("error");
      throw error;
    }
  }

  async streamAsk(
    user: CurrentUserContext,
    input: AskInput,
    signal: AbortSignal,
    options: KbAskOptions = {},
  ): Promise<
    | { hasContext: false }
    | {
        hasContext: true;
        aiStream: AiTextStream;
        citations: AskCitation[];
        verifyCitations: () => Promise<AskCitation[]>;
      }
  > {
    const correlationId = randomUUID();
    const metrics = KbAskMetrics.begin({ orgId: user.orgId });
    try {
      const gathered = await this.gatherContext(user, input, options);
      if (gathered.kind === "no-context") {
        this.noContextAnswer(user, input.question, correlationId);
        void this.writeNoContextInteraction(user, correlationId);
        metrics.finish("no_context");
        return { hasContext: false };
      }
      const { fullContext, top, sources, linked, citations, degraded } = gathered;
      const candidates = top.length + sources.length + linked.length;
      const sourceIdsWithRevisions = buildSourceRecords(top, sources, linked);

      await runInTenantTransaction(
        this.db,
        async (tx) => {
          await tx.insert(kbAiInteractions).values({
            orgId: user.orgId,
            correlationId,
            actorMembershipId: actingMembershipId(user.principal) ?? null,
            resultState: "answered",
            sourceIdsWithRevisions,
          });
          await this.events.record(user.orgId, "ai_answer", {
            actorMembershipId: actingMembershipId(user.principal) ?? null,
            query: input.question,
            metadata: {
              sourceIds: [
                ...top.map((s) => `${s.kind}:${s.id}`),
                ...linked.map((document) => `document:${document.id}`),
              ],
            },
            correlationId,
          });
        },
        { orgId: user.orgId },
      );

      const aiStream = await this.aiGateway.streamTextWithUsage({
        actor: { orgId: user.orgId, userId: user.userId },
        feature: "kb.ask",
        tier: "fast",
        maxTokens: 1024,
        charge: true,
        prompt: {
          system: ASK_SYSTEM_PROMPT,
          user: `Question: ${input.question}\n\nContext:\n${fullContext}`,
        },
        signal,
      });

      metrics.finish(degraded ? "degraded" : "answered", {
        citations: citations.length,
        candidates,
        degraded,
      });
      return {
        hasContext: true,
        aiStream,
        citations,
        verifyCitations: () =>
          runInTenantTransaction(
            this.db,
            async () => [
              ...(await this.resolveCitations(user, top, sources)),
              ...(await this.stillCitableDocuments(user, linked)),
            ],
            { orgId: user.orgId },
          ),
      };
    } catch (error) {
      metrics.finish("error");
      throw error;
    }
  }

  private async orgHasIndexedContent(orgId: string): Promise<boolean> {
    const rows = await this.db.execute(
      sql`SELECT 1 AS one FROM kb_article_chunks WHERE org_id = ${orgId} LIMIT 1`,
    );
    return rows.length > 0;
  }

  async reportKnowledgeGap(
    user: CurrentUserContext,
    question: string,
  ): Promise<void> {
    await this.events.record(user.orgId, "search_no_results", {
      actorMembershipId: actingMembershipId(user.principal) ?? null,
      query: question,
      metadata: { reportedFromAsk: true },
    });
  }

  async assertReplayCitations(
    user: CurrentUserContext,
    citations: AskCitation[],
  ): Promise<void> {
    await runInTenantTransaction(
      this.db,
      async () => {
        const articleIds = citations.flatMap((citation) =>
          citation.kind === "article" ? [citation.articleId] : [],
        );
        const pageIds = citations.flatMap((citation) =>
          citation.kind === "page" ? [citation.pageId] : [],
        );
        const sourceIds = citations.flatMap((citation) =>
          citation.kind === "source" ? [citation.sourceId] : [],
        );
        const linkedDocumentIds = citations.flatMap((citation) =>
          citation.kind === "document" ? [citation.linkedDocumentId] : [],
        );
        const [articles, pages, sources, documents] = await Promise.all([
          articleIds.length
            ? this.citationVisibility.visibleArticles(user, articleIds)
            : Promise.resolve(new Set<number>()),
          pageIds.length
            ? this.citationVisibility.visiblePages(user, pageIds)
            : Promise.resolve(new Set<number>()),
          sourceIds.length
            ? this.citationVisibility.visibleSources(user, sourceIds)
            : Promise.resolve(new Set<number>()),
          this.linkedDocuments.stillCitable(user, linkedDocumentIds),
        ]);
        if (
          articleIds.some((id) => !articles.has(id)) ||
          pageIds.some((id) => !pages.has(id)) ||
          sourceIds.some((id) => !sources.has(id)) ||
          linkedDocumentIds.some((id) => !documents.has(id))
        )
          throw new NotFoundException(
            "The saved answer is no longer accessible",
          );
      },
      { orgId: user.orgId },
    );
  }

  private async stillCitableDocuments(
    user: CurrentUserContext,
    linked: LinkedDocumentItem[],
  ): Promise<AskCitation[]> {
    const citable = await this.linkedDocuments.stillCitable(
      user,
      linked.map((document) => document.id),
    );
    return linked
      .filter((document) => citable.has(document.id))
      .map((document) => this.linkedDocuments.citationOf(document));
  }

  private async resolveCitations(
    user: CurrentUserContext,
    top: Awaited<ReturnType<KbSearchService["retrieveTopArticles"]>>,
    sources: Awaited<ReturnType<KbSearchService["retrieveTopSources"]>>,
  ): Promise<AskCitation[]> {
    const articleIds = top.filter((s) => s.kind === "article").map((s) => s.id);
    const pageIds = top.filter((s) => s.kind === "page").map((s) => s.id);
    const sourceIds = sources.map((s) => s.sourceId);

    const [visibleArticles, visiblePages, visibleSources] = await Promise.all([
      articleIds.length > 0
        ? this.citationVisibility.visibleArticles(user, articleIds)
        : Promise.resolve(new Set<number>()),
      pageIds.length > 0
        ? this.citationVisibility.visiblePages(user, pageIds)
        : Promise.resolve(new Set<number>()),
      sourceIds.length > 0
        ? this.citationVisibility.visibleSources(user, sourceIds)
        : Promise.resolve(new Set<number>()),
    ]);

    const citations: AskCitation[] = [];
    for (const source of top) {
      if (source.kind === "article" && visibleArticles.has(source.id)) {
        citations.push({
          kind: "article",
          articleId: source.id,
          title: source.title,
          slug: source.slug,
          spaceId: source.spaceId,
          updatedAt: source.updatedAt,
        });
      } else if (source.kind === "page" && visiblePages.has(source.id)) {
        citations.push({
          kind: "page",
          pageId: source.id,
          title: source.title,
          spaceId: source.spaceId,
          updatedAt: source.updatedAt,
        });
      }
    }
    for (const s of sources) {
      if (visibleSources.has(s.sourceId)) {
        citations.push({
          kind: "source",
          sourceId: s.sourceId,
          title: s.title,
          spaceId: s.spaceId,
          updatedAt: s.updatedAt,
        });
      }
    }
    return citations;
  }
}
