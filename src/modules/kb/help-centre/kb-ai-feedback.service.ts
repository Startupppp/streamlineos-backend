import { Injectable } from "@nestjs/common";
import { KbEventsService } from "../core/kb-events.service";
import { actingMembershipId } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { KbAiFeedbackInput } from "../retrieval/dto/kb-ai.schemas";

@Injectable()
export class KbAiFeedbackService {
  constructor(private readonly events: KbEventsService) {}

  async recordAnswerFeedback(user: CurrentUserContext, data: KbAiFeedbackInput): Promise<void> {
    await this.events.record(user.orgId, "ai_feedback", {
      actorMembershipId: actingMembershipId(user.principal) ?? null,
      query: data.question,
      metadata: { rating: data.rating, comment: data.comment ?? null },
    });
  }
}
