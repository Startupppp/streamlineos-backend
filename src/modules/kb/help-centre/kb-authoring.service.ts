import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { InsufficientAiCreditsException } from "../../../common/http/api-exceptions";
import { KbEventsService } from "../core/kb-events.service";
import { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import { actingMembershipId } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { DraftInput, ImproveInput, SummarizeInput } from "./dto/kb-authoring.schemas";

@Injectable()
export class KbAuthoringService {
  constructor(
    private readonly gateway: AiGatewayService,
    private readonly events: KbEventsService,
  ) {}

  private async run(
    user: CurrentUserContext,
    feature: string,
    system: string,
    prompt: string,
  ): Promise<{ content: string }> {
    const result = await this.gateway.invokeTextWithUsage({
      actor: { orgId: user.orgId, userId: user.userId },
      feature: `kb.authoring.${feature}`,
      tier: "fast",
      maxTokens: 2048,
      charge: true,
      prompt: { system, user: prompt },
    });
    if (!result.ok) {
      if (result.kind === "quota_exceeded")
        throw new InsufficientAiCreditsException({ message: result.message });
      throw new ServiceUnavailableException("AI assistant is temporarily unavailable");
    }
    await this.events.record(user.orgId, "ai_answer", {
      actorMembershipId: actingMembershipId(user.principal) ?? null,
      metadata: { feature },
    });
    return { content: result.data };
  }

  draft(user: CurrentUserContext, input: DraftInput): Promise<{ content: string }> {
    const system =
      "You are a senior technical writer. Write a clear, well-structured knowledge base article in Markdown (short intro, ## headings, concise paragraphs, lists where useful). Return only the article body.";
    const prompt = input.title
      ? `Title: ${input.title}\n\nTopic/brief: ${input.prompt}`
      : input.prompt;
    return this.run(user, "draft", system, prompt);
  }

  improve(user: CurrentUserContext, input: ImproveInput): Promise<{ content: string }> {
    const system =
      "Improve the clarity, grammar, flow, and structure of the following knowledge base content WITHOUT changing its meaning or removing information. Return only the improved content.";
    const prompt = input.instruction
      ? `Instruction: ${input.instruction}\n\nContent:\n${input.text}`
      : input.text;
    return this.run(user, "improve", system, prompt);
  }

  summarize(user: CurrentUserContext, input: SummarizeInput): Promise<{ content: string }> {
    const system =
      "Summarize the following article into a concise 1–2 sentence excerpt (max ~300 chars). Return only the excerpt.";
    return this.run(user, "summarize", system, input.text);
  }
}
