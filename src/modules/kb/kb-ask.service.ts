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
    citations: { articleId: number; title: string; slug: string; spaceId: number | null }[];
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
      .map((article, index) => `[${index + 1}] ${article.title}\n${(article.contentText || "").slice(0, MAX_CONTEXT_CHARS)}`)
      .join("\n\n---\n\n");

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
        user: `Question: ${input.question}\n\nContext:\n${context}`,
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
      metadata: { articleIds: top.map((article) => article.id) },
    });

    return {
      answer,
      citations: top.map((article) => ({
        articleId: article.id,
        title: article.title,
        slug: article.slug,
        spaceId: article.spaceId,
      })),
      hasContext: true,
    };
  }
}
