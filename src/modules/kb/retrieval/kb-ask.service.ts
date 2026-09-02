import { Inject, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { and, eq, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { InsufficientAiCreditsException } from "../../../common/http/api-exceptions";
import { KbEventsService } from "../core/kb-events.service";
import { KbSearchService } from "./kb-search.service";
import { KbAccessService } from "../core/kb-access.service";
import { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import { kbArticles, kbPages, kbSources } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
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

  async ask(
    user: CurrentUserContext,
    input: AskInput,
  ): Promise<{
    answer: string;
    citations: AskCitation[];
    hasContext: boolean;
    aiUsage?: AiUsageMeta;
  }> {
    const hasContent = await this.orgHasIndexedContent(user.orgId);
    if (!hasContent) {
      this.events.record(user.orgId, "ai_answer_no_context", {
        actorMembershipId: actingMembershipId(user.principal) ?? null,
        query: input.question,
      }).catch((err: unknown) => {
        this.logger.warn(`Failed to record ai_answer_no_context event: ${err}`);
      });
      return {
        answer:
          "I couldn't find anything about that in the knowledge base. You may want to open a support ticket.",
        citations: [],
        hasContext: false,
      };
    }

    const top = await this.search.retrieveTopArticles(
      user,
      input.question,
      MAX_CONTEXT_ARTICLES,
      input.spaceId,
    );
    const sources = await this.search.retrieveTopSources(user, input.question, 4);
    if (top.length === 0 && sources.length === 0) {
      this.events.record(user.orgId, "ai_answer_no_context", {
        actorMembershipId: actingMembershipId(user.principal) ?? null,
        query: input.question,
      }).catch((err: unknown) => {
        this.logger.warn(`Failed to record ai_answer_no_context event: ${err}`);
      });
      return {
        answer:
          "I couldn't find anything about that in the knowledge base. You may want to open a support ticket.",
        citations: [],
        hasContext: false,
      };
    }

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

    await this.events.record(user.orgId, "ai_answer", {
      actorMembershipId: actingMembershipId(user.principal) ?? null,
      query: input.question,
      metadata: { sourceIds: top.map((s) => `${s.kind}:${s.id}`) },
    });

    const verifiedCitations = await this.resolveCitations(user, top, sources);

    return { answer, citations: verifiedCitations, hasContext: true, aiUsage };
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

  private async resolveVisibleArticles(user: CurrentUserContext, ids: number[]): Promise<Set<number>> {
    const spaceIds = await this.access.getAccessibleSpaceIds(user);
    if (spaceIds.length === 0) return new Set();
    const ownerFilter = await this.search.articleOwnerFilterFor(user);
    const conditions: SQL[] = [
      eq(kbArticles.orgId, user.orgId),
      inArray(kbArticles.id, ids),
      inArray(kbArticles.spaceId, spaceIds),
      eq(kbArticles.status, "published"),
    ];
    if (ownerFilter) conditions.push(ownerFilter);
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
