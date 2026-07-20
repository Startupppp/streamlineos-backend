import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { KbEventsService } from "./kb-events.service";
import { KbSearchService } from "./kb-search.service";
import { AiGatewayService } from "../ai/gateway/ai-gateway.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { AskInput } from "./dto/kb-ai.schemas";
import type { AiUsageMeta } from "../ai/gateway/ai-gateway.types";

const MAX_CONTEXT_ARTICLES = 6;
const MAX_CONTEXT_CHARS = 1500;

const ASK_SYSTEM_PROMPT =
  "You are a knowledge base assistant. Answer the user's question using ONLY the information in the provided context. " +
  "Write a clear, well-structured answer in Markdown: open with a one-sentence summary, then use bullet or numbered lists with short **bold labels** where it aids readability. Keep it concise and scannable. " +
  "Do NOT include inline citations, reference numbers, or bracketed markers such as [1] or [doc 2] — the user is shown the list of sources separately. " +
  "If the context does not contain the answer, say you don't have that information and suggest opening a support ticket. " +
  "Never invent facts that are not present in the context.";

export type AskCitation =
  | { kind: "article"; articleId: number; title: string; slug: string; spaceId: number | null; updatedAt: Date }
  | { kind: "page"; pageId: number; title: string; spaceId: number | null; updatedAt: Date }
  | { kind: "source"; sourceId: number; title: string; spaceId: number | null; updatedAt: Date };

@Injectable()
export class KbAskService {
  private readonly logger = new Logger(KbAskService.name);

  constructor(
    private readonly aiGateway: AiGatewayService,
    private readonly events: KbEventsService,
    private readonly search: KbSearchService,
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
    const top = await this.search.retrieveTopArticles(
      user,
      input.question,
      MAX_CONTEXT_ARTICLES,
      input.spaceId,
    );
    const sources = await this.search.retrieveTopSources(user, input.question, 4);
    if (top.length === 0 && sources.length === 0) {
      this.events.record(user.orgId, "ai_answer_no_context", {
        actorId: user.userId,
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

    const context = top
      .map((source, index) => `Source ${index + 1} — ${source.title}\n${(source.contentText || "").slice(0, MAX_CONTEXT_CHARS)}`)
      .join("\n\n---\n\n");

    const articleIds = top
      .filter((source) => source.kind === "article")
      .map((source) => source.id);
    const pageIds = top
      .filter((source) => source.kind === "page")
      .map((source) => source.id);
    const attachmentContext = await this.search.retrieveAttachmentSnippets(
      user.orgId,
      input.question,
      articleIds,
      pageIds,
    );
    const sourceContext = sources
      .map((s, index) => `Document ${index + 1} — ${s.title}\n${s.snippet}`)
      .join("\n\n---\n\n");
    let fullContext = attachmentContext
      ? `${context}\n\n---\n\n${attachmentContext}`
      : context;
    if (sourceContext) fullContext = `${fullContext}\n\n---\n\n${sourceContext}`;

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
        throw new BadRequestException(gatewayResult.message);
      }
      throw new ServiceUnavailableException("AI assistant is temporarily unavailable");
    }

    const answer = gatewayResult.data;
    const aiUsage = gatewayResult.aiUsage;

    await this.events.record(user.orgId, "ai_answer", {
      actorId: user.userId,
      query: input.question,
      metadata: { sourceIds: top.map((s) => `${s.kind}:${s.id}`) },
    });

    const citations: AskCitation[] = [
      ...top.map((source): AskCitation => {
        if (source.kind === "article") {
          return { kind: "article", articleId: source.id, title: source.title, slug: source.slug, spaceId: source.spaceId, updatedAt: source.updatedAt };
        }
        return { kind: "page", pageId: source.id, title: source.title, spaceId: source.spaceId, updatedAt: source.updatedAt };
      }),
      ...sources.map((s) => ({ kind: "source" as const, sourceId: s.sourceId, title: s.title, spaceId: s.spaceId, updatedAt: s.updatedAt })),
    ];

    return { answer, citations, hasContext: true, aiUsage };
  }
}
