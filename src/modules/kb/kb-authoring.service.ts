import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { KbCreditsService } from "./kb-credits.service";
import { KbEventsService } from "./kb-events.service";
import { LlmService } from "../ai/core/providers/llm.service";
import type { DraftInput, ImproveInput, SummarizeInput } from "./dto/kb-authoring.schemas";

const COST = 1;

@Injectable()
export class KbAuthoringService {
  constructor(
    private readonly llm: LlmService,
    private readonly credits: KbCreditsService,
    private readonly events: KbEventsService,
  ) {}

  private async run(
    orgId: string,
    userId: string,
    feature: string,
    system: string,
    user: string,
  ): Promise<{ content: string }> {
    if (!this.llm.isConfigured()) {
      throw new ServiceUnavailableException("AI assistant is not available");
    }
    await this.credits.consume(orgId, COST, { reason: `kb_${feature}`, feature, actorId: userId });
    let content: string;
    try {
      content = await this.llm.invokeText({ model: "fast", temperature: 0.4, system, user });
    } catch (error) {
      await this.credits.grant(orgId, COST, { reason: `kb_${feature}_refund`, feature, actorId: userId });
      throw error;
    }
    await this.events.record(orgId, "ai_answer", { actorId: userId, metadata: { feature } });
    return { content };
  }

  draft(orgId: string, userId: string, input: DraftInput): Promise<{ content: string }> {
    const system =
      "You are a senior technical writer. Write a clear, well-structured knowledge base article in Markdown (short intro, ## headings, concise paragraphs, lists where useful). Return only the article body.";
    const user = input.title
      ? `Title: ${input.title}\n\nTopic/brief: ${input.prompt}`
      : input.prompt;
    return this.run(orgId, userId, "draft", system, user);
  }

  improve(orgId: string, userId: string, input: ImproveInput): Promise<{ content: string }> {
    const system =
      "Improve the clarity, grammar, flow, and structure of the following knowledge base content WITHOUT changing its meaning or removing information. Return only the improved content.";
    const user = input.instruction
      ? `Instruction: ${input.instruction}\n\nContent:\n${input.text}`
      : input.text;
    return this.run(orgId, userId, "improve", system, user);
  }

  summarize(orgId: string, userId: string, input: SummarizeInput): Promise<{ content: string }> {
    const system =
      "Summarize the following article into a concise 1–2 sentence excerpt (max ~300 chars). Return only the excerpt.";
    return this.run(orgId, userId, "summarize", system, input.text);
  }
}
