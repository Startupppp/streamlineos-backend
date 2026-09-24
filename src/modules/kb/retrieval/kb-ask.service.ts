import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { InsufficientAiCreditsException } from "../../../common/http/api-exceptions";
import { KbAskMetrics } from "../core/telemetry/kb-ask-metrics";
import { KbEventsService } from "../core/kb-events.service";
import { KbSearchService } from "./kb-search.service";
import { KbCitationVisibilityService } from "./kb-citation-visibility.service";
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
    };

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
    else citedSources.add(citation.sourceId);
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

@Injectable()
export class KbAskService {
  private readonly logger = new Logger(KbAskService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly aiGateway: AiGatewayService,
    private readonly events: KbEventsService,
    private readonly search: KbSearchService,
    private readonly citationVisibility: KbCitationVisibilityService,
  ) {}

  private async gatherContext(
    user: CurrentUserContext,
    input: AskInput,
  ): Promise<
    | { kind: "no-context" }
    | {
        kind: "context";
        fullContext: string;
        top: Awaited<ReturnType<KbSearchService["retrieveTopArticles"]>>;
        sources: Awaited<ReturnType<KbSearchService["retrieveTopSources"]>>;
        citations: AskCitation[];
      }
  > {
    return runInTenantTransaction(
      this.db,
      async () => {
        const hasContent = await this.orgHasIndexedContent(user.orgId);
        if (!hasContent) return { kind: "no-context" as const };

        const retrievedTop = await this.search.retrieveTopArticles(
          user,
          input.question,
          KB_ASK_MAX_CONTEXT_DOCUMENTS,
          input.spaceId,
        );
        const retrievedSources = await this.search.retrieveTopSources(
          user,
          input.question,
          4,
        );
        if (retrievedTop.length === 0 && retrievedSources.length === 0)
          return { kind: "no-context" as const };

        const citations = await this.resolveCitations(
          user,
          retrievedTop,
          retrievedSources,
        );
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
        const documentPassages = await this.search.retrieveDocumentPassages(
          user,
          input.question,
          articleIds,
          pageIds,
        );

        const fullContext = buildKbContext(
          assemblePassages(top, sources, documentPassages),
        );
        if (fullContext.length === 0) return { kind: "no-context" as const };

        return {
          kind: "context" as const,
          fullContext,
          top,
          sources,
          citations,
        };
      },
      { orgId: user.orgId },
    );
  }

  private noContextAnswer(
    user: CurrentUserContext,
    question: string,
  ): { answer: string; citations: AskCitation[]; hasContext: boolean } {
    this.events
      .record(user.orgId, "ai_answer_no_context", {
        actorMembershipId: actingMembershipId(user.principal) ?? null,
        query: question,
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

  async ask(
    user: CurrentUserContext,
    input: AskInput,
  ): Promise<{
    answer: string;
    citations: AskCitation[];
    hasContext: boolean;
    aiUsage?: AiUsageMeta;
  }> {
    const metrics = KbAskMetrics.begin({ orgId: user.orgId });
    try {
      const gathered = await this.gatherContext(user, input);
      if (gathered.kind === "no-context") {
        metrics.finish("no_context");
        return this.noContextAnswer(user, input.question);
      }
      const { fullContext, top, sources, citations } = gathered;
      const candidates = top.length + sources.length;

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

      if (!gatewayResult.ok) {
        if (gatewayResult.kind === "quota_exceeded") {
          metrics.finish("credits_exhausted", {
            citations: citations.length,
            candidates,
          });
          throw new InsufficientAiCreditsException({
            message: gatewayResult.message,
          });
        }
        metrics.finish("provider_unavailable", {
          citations: citations.length,
          candidates,
        });
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
        () =>
          this.events.record(user.orgId, "ai_answer", {
            actorMembershipId: actingMembershipId(user.principal) ?? null,
            query: input.question,
            metadata: { sourceIds: top.map((s) => `${s.kind}:${s.id}`) },
          }),
        { orgId: user.orgId },
      );

      metrics.finish("answered", { citations: citations.length, candidates });
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
  ): Promise<
    | { hasContext: false }
    | {
        hasContext: true;
        aiStream: AiTextStream;
        citations: AskCitation[];
        verifyCitations: () => Promise<AskCitation[]>;
      }
  > {
    const metrics = KbAskMetrics.begin({ orgId: user.orgId });
    try {
      const gathered = await this.gatherContext(user, input);
      if (gathered.kind === "no-context") {
        this.noContextAnswer(user, input.question);
        metrics.finish("no_context");
        return { hasContext: false };
      }
      const { fullContext, top, sources, citations } = gathered;
      const candidates = top.length + sources.length;

      await runInTenantTransaction(
        this.db,
        () =>
          this.events.record(user.orgId, "ai_answer", {
            actorMembershipId: actingMembershipId(user.principal) ?? null,
            query: input.question,
            metadata: { sourceIds: top.map((s) => `${s.kind}:${s.id}`) },
          }),
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

      metrics.finish("answered", { citations: citations.length, candidates });
      return {
        hasContext: true,
        aiStream,
        citations,
        verifyCitations: () =>
          runInTenantTransaction(
            this.db,
            () => this.resolveCitations(user, top, sources),
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
        const [articles, pages, sources] = await Promise.all([
          articleIds.length
            ? this.citationVisibility.visibleArticles(user, articleIds)
            : Promise.resolve(new Set<number>()),
          pageIds.length
            ? this.citationVisibility.visiblePages(user, pageIds)
            : Promise.resolve(new Set<number>()),
          sourceIds.length
            ? this.citationVisibility.visibleSources(user, sourceIds)
            : Promise.resolve(new Set<number>()),
        ]);
        if (
          articleIds.some((id) => !articles.has(id)) ||
          pageIds.some((id) => !pages.has(id)) ||
          sourceIds.some((id) => !sources.has(id))
        )
          throw new NotFoundException(
            "The saved answer is no longer accessible",
          );
      },
      { orgId: user.orgId },
    );
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
