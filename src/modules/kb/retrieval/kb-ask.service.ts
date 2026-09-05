import { Inject, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { and, eq, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { InsufficientAiCreditsException } from "../../../common/http/api-exceptions";
import { KbEventsService } from "../core/kb-events.service";
import { KbSearchService } from "./kb-search.service";
import { KbAccessService } from "../core/kb-access.service";
import { AiGatewayService, type AiTextStream } from "../../ai/core/gateway/ai-gateway.service";
import { kbArticles, kbPages, kbSources } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { pageVisibleTo } from "./kb-page-visibility";
import { getAccessibleProjectIds } from "./kb-project-access.util";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";
import type { AskInput } from "./dto/kb-ai.schemas";
import type { AiUsageMeta } from "../../ai/core/gateway/ai-gateway.types";

const MAX_CONTEXT_ARTICLES = 6;
const MAX_CONTEXT_CHARS = 1500;
const MAX_TOTAL_CONTEXT_BYTES = 32_000;
const MAX_PROMPT_INPUT_TOKENS = 8_000;

const ASK_SYSTEM_PROMPT =
  "You are a knowledge base assistant. Answer the user's question using ONLY the information in the provided context. " +
  "Write a clear, well-structured answer in Markdown: open with a one-sentence summary, then use bullet or numbered lists with short **bold labels** where it aids readability. Keep it concise and scannable. " +
  "Do NOT include inline citations, reference numbers, or bracketed markers such as [1] or [doc 2] — the user is shown the list of sources separately. " +
  "If the context does not contain the answer, say you don't have that information and suggest opening a support ticket. " +
  "Never invent facts that are not present in the context. " +
  "Never reveal permission rules, role names, membership lists or access control details.";

export type AskCitation =
  | { kind: "article"; articleId: number; title: string; slug: string; spaceId: number | null; updatedAt: Date }
  | { kind: "page"; pageId: number; title: string; spaceId: number | null; updatedAt: Date }
  | { kind: "source"; sourceId: number; title: string; spaceId: number | null; updatedAt: Date };

@Injectable()
export class KbAskService {
  private readonly logger = new Logger(KbAskService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly aiGateway: AiGatewayService,
    private readonly events: KbEventsService,
    private readonly search: KbSearchService,
    private readonly access: KbAccessService,
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
      }
  > {
    return runInTenantTransaction(
      this.db,
      async () => {
        const hasContent = await this.orgHasIndexedContent(user.orgId);
        if (!hasContent) return { kind: "no-context" as const };

        const top = await this.search.retrieveTopArticles(
          user,
          input.question,
          MAX_CONTEXT_ARTICLES,
          input.spaceId,
        );
        const sources = await this.search.retrieveTopSources(user, input.question, 4);
        if (top.length === 0 && sources.length === 0) return { kind: "no-context" as const };

        let totalBytes = 0;
        const contextParts: string[] = [];
        for (const source of top) {
          const text = (source.contentText || "").slice(0, MAX_CONTEXT_CHARS);
          const part = `Source — ${source.title}\n${text}`;
          if (totalBytes + part.length > MAX_TOTAL_CONTEXT_BYTES) break;
          contextParts.push(part);
          totalBytes += part.length;
        }
        const context = contextParts.join("\n\n---\n\n");

        const articleIds = top
          .filter((source) => source.kind === "article")
          .map((source) => source.id);
        const pageIds = top
          .filter((source) => source.kind === "page")
          .map((source) => source.id);
        const attachmentContext = await this.search.retrieveAttachmentSnippets(
          user,
          input.question,
          articleIds,
          pageIds,
        );

        const sourceContextParts: string[] = [];
        for (const s of sources) {
          const part = `Document — ${s.title}\n${s.snippet}`;
          if (totalBytes + part.length > MAX_TOTAL_CONTEXT_BYTES) break;
          sourceContextParts.push(part);
          totalBytes += part.length;
        }
        const sourceContext = sourceContextParts.join("\n\n---\n\n");

        let fullContext = attachmentContext
          ? `${context}\n\n---\n\n${attachmentContext}`
          : context;
        if (sourceContext) fullContext = `${fullContext}\n\n---\n\n${sourceContext}`;

        const userMessage = `Question: ${input.question}\n\nContext:\n${fullContext}`;
        if (userMessage.length / 4 > MAX_PROMPT_INPUT_TOKENS) {
          fullContext = fullContext.slice(0, MAX_PROMPT_INPUT_TOKENS * 4);
        }

        return { kind: "context" as const, fullContext, top, sources };
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
    const gathered = await this.gatherContext(user, input);
    if (gathered.kind === "no-context") return this.noContextAnswer(user, input.question);
    const { fullContext, top, sources } = gathered;

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
        throw new InsufficientAiCreditsException({ message: gatewayResult.message });
      }
      throw new ServiceUnavailableException("AI assistant is temporarily unavailable");
    }

    const answer = gatewayResult.data;
    const aiUsage = gatewayResult.aiUsage;

    const verifiedCitations = await runInTenantTransaction(
      this.db,
      async () => {
        await this.events.record(user.orgId, "ai_answer", {
          actorMembershipId: actingMembershipId(user.principal) ?? null,
          query: input.question,
          metadata: { sourceIds: top.map((s) => `${s.kind}:${s.id}`) },
        });
        return this.resolveCitations(user, top, sources);
      },
      { orgId: user.orgId },
    );

    return { answer, citations: verifiedCitations, hasContext: true, aiUsage };
  }

  async streamAsk(
    user: CurrentUserContext,
    input: AskInput,
    signal: AbortSignal,
  ): Promise<
    | { hasContext: false }
    | { hasContext: true; aiStream: AiTextStream; citations: AskCitation[] }
  > {
    const gathered = await this.gatherContext(user, input);
    if (gathered.kind === "no-context") {
      this.noContextAnswer(user, input.question);
      return { hasContext: false };
    }
    const { fullContext, top, sources } = gathered;

    const verifiedCitations = await runInTenantTransaction(
      this.db,
      async () => {
        await this.events.record(user.orgId, "ai_answer", {
          actorMembershipId: actingMembershipId(user.principal) ?? null,
          query: input.question,
          metadata: { sourceIds: top.map((s) => `${s.kind}:${s.id}`) },
        });
        return this.resolveCitations(user, top, sources);
      },
      { orgId: user.orgId },
    );

    const aiStream = await this.aiGateway.streamTextWithUsage({
      actor: { orgId: user.orgId, userId: user.userId },
      feature: "kb.ask",
      maxTokens: 1024,
      charge: true,
      prompt: {
        system: ASK_SYSTEM_PROMPT,
        user: `Question: ${input.question}\n\nContext:\n${fullContext}`,
      },
      signal,
    });

    return { hasContext: true, aiStream, citations: verifiedCitations };
  }

  private async orgHasIndexedContent(orgId: string): Promise<boolean> {
    const rows = await this.db.execute(
      sql`SELECT 1 AS one FROM kb_article_chunks WHERE org_id = ${orgId} LIMIT 1`,
    );
    return rows.length > 0;
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
        ? this.resolveVisibleArticles(user, articleIds)
        : Promise.resolve(new Set<number>()),
      pageIds.length > 0
        ? this.resolveVisiblePages(user, pageIds)
        : Promise.resolve(new Set<number>()),
      sourceIds.length > 0
        ? this.resolveVisibleSources(user, sourceIds)
        : Promise.resolve(new Set<number>()),
    ]);

    const citations: AskCitation[] = [];
    for (const source of top) {
      if (source.kind === "article" && visibleArticles.has(source.id)) {
        citations.push({ kind: "article", articleId: source.id, title: source.title, slug: source.slug, spaceId: source.spaceId, updatedAt: source.updatedAt });
      } else if (source.kind === "page" && visiblePages.has(source.id)) {
        citations.push({ kind: "page", pageId: source.id, title: source.title, spaceId: source.spaceId, updatedAt: source.updatedAt });
      }
    }
    for (const s of sources) {
      if (visibleSources.has(s.sourceId)) {
        citations.push({ kind: "source", sourceId: s.sourceId, title: s.title, spaceId: s.spaceId, updatedAt: s.updatedAt });
      }
    }
    return citations;
  }

  private async resolveVisibleSources(user: CurrentUserContext, ids: number[]): Promise<Set<number>> {
    const accessibleSpaceIds = await this.access.getAccessibleSpaceIds(user);
    const spaceFilter = accessibleSpaceIds.length > 0
      ? or(isNull(kbSources.spaceId), inArray(kbSources.spaceId, accessibleSpaceIds))
      : isNull(kbSources.spaceId);
    const rows = await this.db
      .select({ id: kbSources.id })
      .from(kbSources)
      .where(and(
        eq(kbSources.orgId, user.orgId),
        inArray(kbSources.id, ids),
        isNull(kbSources.deletedAt),
        eq(kbSources.status, "ready"),
        spaceFilter,
      ));
    return new Set(rows.map((r) => r.id));
  }

  /**
   * Re-verification, not a second retrieval — so it has to re-apply BOTH article ACL
   * dimensions, or it is blind to a revocation in exactly the window it exists to cover.
   *
   * It used to re-apply only org, accessible spaces, `status='published'` and the owner
   * DataScope. `kb_article_restrictions` — the per-article ACL that
   * `KbCandidateService.article{Keyword,Vector}Candidates` and
   * `KbSearchService.retrieveTopArticles` all push into the retrieval predicate — was
   * missing. An article restricted to another membership between the moment retrieval
   * picked it and the moment the model answered was still cited by title, slug and
   * space to a reader who could no longer open it.
   */
  private async resolveVisibleArticles(user: CurrentUserContext, ids: number[]): Promise<Set<number>> {
    const spaceIds = await this.access.getAccessibleSpaceIds(user);
    if (spaceIds.length === 0) return new Set();
    const [ownerFilter, restrictionFilter] = await Promise.all([
      this.search.articleOwnerFilterFor(user),
      this.search.articleRestrictionFilterFor(user),
    ]);
    const conditions: SQL[] = [
      eq(kbArticles.orgId, user.orgId),
      inArray(kbArticles.id, ids),
      inArray(kbArticles.spaceId, spaceIds),
      eq(kbArticles.status, "published"),
    ];
    if (ownerFilter) conditions.push(ownerFilter);
    if (restrictionFilter) conditions.push(restrictionFilter);
    const rows = await this.db
      .select({ id: kbArticles.id })
      .from(kbArticles)
      .where(and(...conditions));
    return new Set(rows.map((r) => r.id));
  }

  private async resolveVisiblePages(user: CurrentUserContext, ids: number[]): Promise<Set<number>> {
    const projectIds = await getAccessibleProjectIds(this.db, user);
    const rows = await this.db
      .select({ id: kbPages.id })
      .from(kbPages)
      .where(and(
        eq(kbPages.orgId, user.orgId),
        inArray(kbPages.id, ids),
        isNull(kbPages.deletedAt),
        ne(kbPages.status, "archived"),
        pageVisibleTo(user, projectIds),
      ));
    return new Set(rows.map((r) => r.id));
  }
}
