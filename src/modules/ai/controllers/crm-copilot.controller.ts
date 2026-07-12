import {
  Body,
  Controller,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { LlmService } from "../providers/llm.service";
import { CrmCopilotService } from "../services/crm-copilot.service";

const nextBestActionsSchema = z.object({
  limit: z.number().int().min(1).max(20).default(10),
});

const emailDraftSchema = z.object({
  entityType: z.enum(["lead", "deal"]),
  entityId: z.number().int().positive(),
  intent: z.string().min(1).max(1000),
  tone: z.enum(["formal", "friendly", "urgent"]).default("friendly"),
});

const summarizeNotesSchema = z.object({
  text: z.string().min(10).max(8000),
});

const objectionHelpSchema = z.object({
  objection: z.string().min(1).max(2000),
  context: z.string().max(1000).optional(),
});

@Controller("ai/crm")
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequirePermission("crm:ai:use")
export class CrmCopilotController {
  constructor(
    private readonly llm: LlmService,
    private readonly copilot: CrmCopilotService,
  ) {}

  private ensureLlm(): void {
    if (!this.llm.isConfigured()) {
      throw new ServiceUnavailableException("AI provider is not configured. Set OPENAI_API_KEY.");
    }
  }

  @Post("leads/:leadId/summary")
  async leadSummary(
    @Param("leadId", ParseIntPipe) leadId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    this.ensureLlm();
    const result = await this.copilot.leadSummary(u.orgId, leadId, u.userId);
    if (!result) throw new NotFoundException("Lead not found");
    return result;
  }

  @Post("deals/:dealId/summary")
  async dealSummary(
    @Param("dealId", ParseIntPipe) dealId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    this.ensureLlm();
    return this.copilot.dealSummary(u.orgId, dealId, u.userId);
  }

  @Post("next-best-actions")
  nextBestActions(
    @Body(new ZodValidationPipe(nextBestActionsSchema)) body: z.infer<typeof nextBestActionsSchema>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    this.ensureLlm();
    return this.copilot.nextBestActionsAcrossPipeline(u.orgId, u.userId, body.limit);
  }

  @Post("email-draft")
  emailDraft(
    @Body(new ZodValidationPipe(emailDraftSchema)) body: z.infer<typeof emailDraftSchema>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    this.ensureLlm();
    return this.copilot.emailDraftForEntity(u.orgId, u.userId, body);
  }

  @Post("summarize-notes")
  summarizeNotes(
    @Body(new ZodValidationPipe(summarizeNotesSchema)) body: z.infer<typeof summarizeNotesSchema>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    this.ensureLlm();
    return this.copilot.summarizeNotes(u.orgId, u.userId, body.text);
  }

  @Post("objection-help")
  objectionHelp(
    @Body(new ZodValidationPipe(objectionHelpSchema)) body: z.infer<typeof objectionHelpSchema>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    this.ensureLlm();
    return this.copilot.objectionHelp(u.orgId, u.userId, { objection: body.objection, context: body.context });
  }

  @Post("duplicate-suggestions/:leadId")
  duplicateSuggestions(
    @Param("leadId", ParseIntPipe) leadId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    this.ensureLlm();
    return this.copilot.duplicateSuggestionsForLead(u.orgId, leadId, u.userId);
  }
}
