import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Redis } from "@upstash/redis";
import { InsufficientAiCreditsException } from "../../../common/http/api-exceptions";
import { REDIS } from "../../../common/cache/cache.service";
import {
  KbAskMetrics,
  KB_ASK_QUEUE_LANE,
} from "../core/telemetry/kb-ask-metrics";
import { KbEventsService } from "../core/kb-events.service";
import { KbSearchService } from "./kb-search.service";
import { KbLinkedDocumentAskSource } from "../linked-documents/kb-linked-document-ask-source";
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
  AskCitation,
  ASK_SYSTEM_PROMPT,
  assemblePassages,
  buildKbContext,
  buildAskSourceRecords,
  KB_ASK_MAX_CONTEXT_DOCUMENTS,
  KbAskOptions,
  restrictToCited,
} from "./kb-ask-context";
import { kbAiInteractions } from "../../../db/schema";
import { PROCESS_CELL_ID } from "../../../common/cell-resources/cell-id";
import {
  KbRetrievalService,
  isAnyChannelDegraded,
} from "./kb-retrieval.service";
import { KbAskCitationService } from "./kb-ask-citations.service";
import { chargeKbAskOrgBudget } from "./kb-ask-rate-limit";
import type {
  RetrievedSource,
  RetrievedSourceDocument,
} from "./kb-search-retrieval.service";

export type { AskCitation, KbAskOptions };
export { KB_ASK_ORG_TIER } from "./kb-ask-rate-limit";

@Injectable()
export class KbAskService {
  private readonly logger = new Logger(KbAskService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly aiGateway: AiGatewayService,
    private readonly events: KbEventsService,
    private readonly search: KbSearchService,
    private readonly citationsService: KbAskCitationService,
    private readonly linkedDocuments: KbLinkedDocumentAskSource,
    @Inject(REDIS) private readonly redis: Redis | null,
    private readonly retrieval: KbRetrievalService,
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
        top: RetrievedSource[];
        sources: RetrievedSourceDocument[];
        linked: LinkedDocumentItem[];
        citations: AskCitation[];
        degraded: boolean;
      }
  > {
    const [retrieved, linked] = await Promise.all([
      this.retrieval.retrieve(user, input.question, {
        documentsLimit: KB_ASK_MAX_CONTEXT_DOCUMENTS,
        sourcesLimit: 4,
        spaceId: input.spaceId,
        verifiedOnly: input.verifiedOnly,
        sourceIds: input.sourceIds,
      }),
      runInTenantTransaction(
        this.db,
        async () =>
          options.companyDocuments === true
            ? this.linkedDocuments.retrieve(user, input.question)
            : Promise.resolve<LinkedDocumentItem[]>([]),
        { orgId: user.orgId },
      ),
    ]);

    if (
      retrieved.documents.length === 0 &&
      retrieved.sources.length === 0 &&
      linked.length === 0
    )
      return { kind: "no-context" as const };

    return runInTenantTransaction(
      this.db,
      async () => {
        const citations = [
          ...(await this.citationsService.resolveCitations(
            user,
            retrieved.documents,
            retrieved.sources,
          )),
          ...linked.map((document) =>
            this.linkedDocuments.citationOf(document),
          ),
        ];
        if (citations.length === 0) return { kind: "no-context" as const };

        const { top, sources } = restrictToCited(
          retrieved.documents,
          retrieved.sources,
          citations,
        );

        const fullContext = buildKbContext(
          assemblePassages(
            top,
            sources,
            retrieved.passages,
            linked.map((document) => this.linkedDocuments.passageOf(document)),
          ),
        );
        if (fullContext.length === 0) return { kind: "no-context" as const };

        return {
          kind: "context" as const,
          fullContext,
          top,
          sources,
          linked,
          citations,
          degraded: isAnyChannelDegraded(retrieved.degraded),
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
    await chargeKbAskOrgBudget(this.redis, user.orgId);
    const metrics = KbAskMetrics.begin({
      orgId: user.orgId,
      actorStanding: user.isOrgOwner ? "owner" : "member",
      orgCell: PROCESS_CELL_ID,
    });
    try {
      const cacheOutcome = await this.search.aclCacheOutcome(user);
      const gathered = await this.gatherContext(user, input, options);
      if (gathered.kind === "no-context") {
        metrics.finish("no_context");
        void this.writeNoContextInteraction(user, correlationId);
        return this.noContextAnswer(user, input.question, correlationId);
      }
      const { fullContext, top, sources, linked, citations, degraded } =
        gathered;
      const candidates = top.length + sources.length + linked.length;
      const sourceIdsWithRevisions = buildAskSourceRecords(
        top,
        sources,
        linked,
      );
      const sourceKind =
        sources.length > 0 && top.length > 0
          ? "mixed"
          : sources.length > 0
            ? "source"
            : top.length > 0
              ? "article"
              : "none";
      const queueLane = KB_ASK_QUEUE_LANE;
      const dbRole = "primary";

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
            queueLane,
            sourceKind,
            cacheOutcome,
            dbRole,
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
        if (gatewayResult.kind === "concurrency_exceeded") {
          metrics.finish("provider_unavailable", {
            citations: citations.length,
            candidates,
            queueLane,
            sourceKind,
            cacheOutcome,
            dbRole,
          });
          throw new ServiceUnavailableException(
            "AI concurrency limit reached — retry shortly",
          );
        }
        metrics.finish("provider_unavailable", {
          citations: citations.length,
          candidates,
          queueLane,
          sourceKind,
          cacheOutcome,
          dbRole,
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
                ...linked.map((d) => `document:${d.id}`),
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
        queueLane,
        sourceKind,
        cacheOutcome,
        dbRole,
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
    await chargeKbAskOrgBudget(this.redis, user.orgId);
    const metrics = KbAskMetrics.begin({
      orgId: user.orgId,
      actorStanding: user.isOrgOwner ? "owner" : "member",
      orgCell: PROCESS_CELL_ID,
    });
    try {
      const cacheOutcome = await this.search.aclCacheOutcome(user);
      const gathered = await this.gatherContext(user, input, options);
      if (gathered.kind === "no-context") {
        this.noContextAnswer(user, input.question, correlationId);
        void this.writeNoContextInteraction(user, correlationId);
        metrics.finish("no_context");
        return { hasContext: false };
      }
      const { fullContext, top, sources, linked, citations, degraded } =
        gathered;
      const candidates = top.length + sources.length + linked.length;
      const sourceIdsWithRevisions = buildAskSourceRecords(
        top,
        sources,
        linked,
      );
      const sourceKind =
        sources.length > 0 && top.length > 0
          ? "mixed"
          : sources.length > 0
            ? "source"
            : top.length > 0
              ? "article"
              : "none";
      const queueLane = KB_ASK_QUEUE_LANE;
      const dbRole = "primary";
      const callStart = Date.now();

      const onCompleted = async (result: {
        text: string;
        promptTokens: number;
        completionTokens: number;
        model: string;
        costCredits: number;
        gatewayCorrelationId: string;
      }): Promise<void> => {
        await runInTenantTransaction(
          this.db,
          async (tx) => {
            await tx.insert(kbAiInteractions).values({
              orgId: user.orgId,
              correlationId,
              actorMembershipId: actingMembershipId(user.principal) ?? null,
              resultState: "answered",
              model: result.model,
              promptTokens: result.promptTokens,
              completionTokens: result.completionTokens,
              totalTokens: result.promptTokens + result.completionTokens,
              costCredits: result.costCredits,
              latencyMs: Date.now() - callStart,
              gatewayCorrelationId: result.gatewayCorrelationId,
              sourceIdsWithRevisions,
            });
            await this.events.record(user.orgId, "ai_answer", {
              actorMembershipId: actingMembershipId(user.principal) ?? null,
              query: input.question,
              metadata: {
                sourceIds: [
                  ...top.map((s) => `${s.kind}:${s.id}`),
                  ...linked.map((d) => `document:${d.id}`),
                ],
              },
              correlationId,
            });
          },
          { orgId: user.orgId },
        ).catch((err: unknown) => {
          this.logger.warn(`Failed to record streaming interaction: ${err}`);
        });
      };

      let aiStream: AiTextStream;
      try {
        aiStream = await this.aiGateway.streamTextWithUsage({
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
          onCompleted,
        });
      } catch (streamError: unknown) {
        await runInTenantTransaction(
          this.db,
          async (tx) => {
            await tx.insert(kbAiInteractions).values({
              orgId: user.orgId,
              correlationId,
              actorMembershipId: actingMembershipId(user.principal) ?? null,
              resultState: "provider_unavailable",
              sourceIdsWithRevisions,
            });
          },
          { orgId: user.orgId },
        ).catch((err: unknown) => {
          this.logger.warn(
            `Failed to write streaming error interaction: ${err}`,
          );
        });
        throw streamError;
      }

      metrics.finish(degraded ? "degraded" : "answered", {
        citations: citations.length,
        candidates,
        degraded,
        queueLane,
        sourceKind,
        cacheOutcome,
        dbRole,
      });
      return {
        hasContext: true,
        aiStream,
        citations,
        verifyCitations: () =>
          runInTenantTransaction(
            this.db,
            async () => [
              ...(await this.citationsService.resolveCitations(
                user,
                top,
                sources,
              )),
              ...(await this.citationsService.stillCitableDocuments(
                user,
                linked,
              )),
            ],
            { orgId: user.orgId },
          ),
      };
    } catch (error) {
      metrics.finish("error");
      throw error;
    }
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
}
