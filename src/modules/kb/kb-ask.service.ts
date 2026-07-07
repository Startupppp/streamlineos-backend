import { Injectable } from "@nestjs/common";
import { KbCreditsService } from "./kb-credits.service";
import { KbEventsService } from "./kb-events.service";
import { KbSearchService } from "./kb-search.service";
import { LlmService } from "../ai/providers/llm.service";
import { InsufficientCreditsException } from "./kb.errors";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { AskInput } from "./dto/kb-ai.schemas";

const ASK_COST = 1;
const MAX_CONTEXT_ARTICLES = 6;
const MAX_CONTEXT_CHARS = 1500;

const ASK_SYSTEM_PROMPT =
  "You are a knowledge base assistant. Answer the user's question using ONLY the information in the provided context. " +
  "Cite the sources you rely on inline using their bracket numbers, e.g. [1]. " +
  "If the context does not contain the answer, say you don't have that information and suggest opening a support ticket. " +
  "Never invent facts that are not present in the context.";

export type AskCitation =
  | { kind: "article"; articleId: number; title: string; slug: string; spaceId: number | null }
  | { kind: "page"; pageId: number; title: string; spaceId: number | null };

@Injectable()
export class KbAskService {
  constructor(
    private readonly credits: KbCreditsService,
    private readonly events: KbEventsService,
    private readonly llm: LlmService,
    private readonly search: KbSearchService,
  ) {}

  async ask(
    user: CurrentUserContext,
    input: AskInput,
  ): Promise<{
    answer: string;
    citations: AskCitation[];
    hasContext: boolean;
  }> {
    if (!this.llm.isConfigured()) {
      return { answer: "The AI assistant isn't available right now.", citations: [], hasContext: false };
    }

    if (!(await this.credits.hasCredits(user.orgId, ASK_COST))) {
      throw new InsufficientCreditsException();
    }

    const top = await this.search.retrieveTopArticles(
      user,
      input.question,
      MAX_CONTEXT_ARTICLES,
      input.spaceId,
    );
    if (top.length === 0) {
      return {
        answer:
          "I couldn't find anything about that in the knowledge base. You may want to open a support ticket.",
        citations: [],
        hasContext: false,
      };
    }

    const context = top
      .map((source, index) => `[${index + 1}] ${source.title}\n${(source.contentText || "").slice(0, MAX_CONTEXT_CHARS)}`)
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
    const fullContext = attachmentContext
      ? `${context}\n\n---\n\n${attachmentContext}`
      : context;

    await this.credits.consume(user.orgId, ASK_COST, {
      reason: "kb_ask",
      feature: "ask",
      actorId: user.userId,
    });

    let answer: string;
    try {
      answer = await this.llm.invokeText({
        model: "fast",
        temperature: 0.2,
        system: ASK_SYSTEM_PROMPT,
        user: `Question: ${input.question}\n\nContext:\n${fullContext}`,
      });
    } catch (error) {
      await this.credits.grant(user.orgId, ASK_COST, {
        reason: "kb_ask_refund",
        feature: "ask",
        actorId: user.userId,
      });
      throw error;
    }

    await this.events.record(user.orgId, "ai_answer", {
      actorId: user.userId,
      query: input.question,
      metadata: { sourceIds: top.map((s) => `${s.kind}:${s.id}`) },
    });

    const citations: AskCitation[] = top.map((source) => {
      if (source.kind === "article") {
        return { kind: "article", articleId: source.id, title: source.title, slug: source.slug, spaceId: source.spaceId };
      }
      return { kind: "page", pageId: source.id, title: source.title, spaceId: source.spaceId };
    });

    return { answer, citations, hasContext: true };
  }
}
