import { Injectable } from "@nestjs/common";
import { KbEventsService } from "./kb-events.service";
import type { KbAiFeedbackInput } from "./dto/kb-ai.schemas";

@Injectable()
export class KbAiFeedbackService {
  constructor(private readonly events: KbEventsService) {}

  async recordAnswerFeedback(orgId: string, userId: string, data: KbAiFeedbackInput): Promise<void> {
    await this.events.record(orgId, "ai_feedback", {
      actorId: userId,
      query: data.question,
      metadata: { rating: data.rating, comment: data.comment ?? null },
    });
  }
}
