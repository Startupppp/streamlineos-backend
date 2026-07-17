import {
  Body,
  Controller,
  ForbiddenException,
  Post,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RateLimitGuard } from "../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../common/ratelimit/use-rate-limit.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { LlmService } from "../providers/llm.service";
import { OrgFeaturesService } from "../services/org-features.service";
import { MeetingsPrepService } from "../services/meetings-prep.service";
import {
  meetingPrepBodySchema,
  meetingFollowUpBodySchema,
  meetingSendConfirmBodySchema,
  proposeSendBodySchema,
  type MeetingPrepBodyInput,
  type MeetingFollowUpBodyInput,
  type MeetingSendConfirmBodyInput,
  type ProposeSendBodyInput,
} from "../dto/meetings.schemas";

@Controller("ai/meetings")
@UseGuards(JwtAuthGuard, PermissionGuard, RateLimitGuard)
@RequirePermission("calendar:ai:use")
@UseRateLimit("ai:invoke")
export class MeetingsAiController {
  constructor(
    private readonly meetingsPrep: MeetingsPrepService,
    private readonly orgFeatures: OrgFeaturesService,
    private readonly llm: LlmService,
  ) {}

  private ensureLlm(): void {
    if (!this.llm.isConfigured()) throw new ServiceUnavailableException("AI is not configured. Set OPENAI_API_KEY.");
  }

  private async requireAiFlag(orgId: string): Promise<void> {
    const flags = await this.orgFeatures.getFlags(orgId);
    if (!flags.aiChat) throw new ForbiddenException("AI features are disabled for this organization");
  }

  @Post("prep")
  async prep(
    @Body(new ZodValidationPipe(meetingPrepBodySchema)) body: MeetingPrepBodyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.requireAiFlag(u.orgId);
    this.ensureLlm();
    return this.meetingsPrep.draftAgenda(u.orgId, u.userId, body.eventId, {
      includeCrmContext: body.includeCrmContext,
      includeProjectContext: body.includeProjectContext,
    });
  }

  @Post("follow-up")
  async followUp(
    @Body(new ZodValidationPipe(meetingFollowUpBodySchema)) body: MeetingFollowUpBodyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.requireAiFlag(u.orgId);
    this.ensureLlm();
    return this.meetingsPrep.draftFollowUp(
      u.orgId,
      u.userId,
      body.eventId,
      body.meetingNotes,
      body.actionItems,
    );
  }

  @Post("follow-up/propose-send")
  async proposeSend(
    @Body(new ZodValidationPipe(proposeSendBodySchema)) body: ProposeSendBodyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.requireAiFlag(u.orgId);
    return this.meetingsPrep.proposeSendFollowUp(
      u.orgId,
      u.userId,
      body.eventId,
      body.followUpDraft,
      body.channel,
    );
  }

  @Post("follow-up/confirm-send")
  async confirmSend(
    @Body(new ZodValidationPipe(meetingSendConfirmBodySchema)) body: MeetingSendConfirmBodyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.meetingsPrep.executeSendFollowUp(u.orgId, u.userId, body.token);
  }
}
