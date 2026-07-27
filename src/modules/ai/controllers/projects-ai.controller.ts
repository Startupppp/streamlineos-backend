import {
  BadRequestException,
  Body,
  Controller,
  Param,
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
import { ProjectsAiService } from "../services/projects-ai.service";
import { TicketAiService } from "../services/ticket-ai.service";
import { requireFeature } from "../billing/feature-gates";
import {
  planBodySchema,
  extractBodySchema,
  askBodySchema,
  weeklyUpdateBodySchema,
  type PlanBodyInput,
  type ExtractBodyInput,
  type AskBodyInput,
  type WeeklyUpdateBodyInput,
} from "../dto/pm.schemas";
import {
  improveDescriptionBodySchema,
  draftTicketBodySchema,
  type ImproveDescriptionBodyInput,
  type DraftTicketBodyInput,
} from "../dto/ticket-ai.schemas";

function parsePositiveInt(raw: string, label: string): number {
  const id = parseInt(raw, 10);
  if (Number.isNaN(id) || id <= 0) throw new BadRequestException(`Invalid ${label}`);
  return id;
}

function parseProjectId(raw: string): number {
  return parsePositiveInt(raw, "projectId");
}

@Controller("ai")
@UseGuards(JwtAuthGuard, PermissionGuard, RateLimitGuard)
@RequirePermission("build:ai:use")
@UseRateLimit("ai:invoke")
export class ProjectsAiController {
  constructor(
    private readonly llm: LlmService,
    private readonly projectsAi: ProjectsAiService,
    private readonly ticketAi: TicketAiService,
  ) {}

  private ensureLlm(): void {
    if (!this.llm.isConfigured()) throw new ServiceUnavailableException("AI is not configured. Set OPENAI_API_KEY.");
  }

  @Post("projects/:projectId/summary")
  async summary(@Param("projectId") rawId: string, @CurrentUser() u: CurrentUserContext) {
    requireFeature(u.plan, "ai.project-manager");
    this.ensureLlm();
    return this.projectsAi.summarize(u.orgId, parseProjectId(rawId), u.userId);
  }

  @Post("projects/:projectId/risks")
  async risks(@Param("projectId") rawId: string, @CurrentUser() u: CurrentUserContext) {
    requireFeature(u.plan, "ai.project-manager");
    this.ensureLlm();
    return this.projectsAi.detectRisks(u.orgId, parseProjectId(rawId), u.userId);
  }

  @Post("projects/:projectId/client-update")
  async clientUpdate(@Param("projectId") rawId: string, @CurrentUser() u: CurrentUserContext) {
    requireFeature(u.plan, "ai.project-manager");
    this.ensureLlm();
    return this.projectsAi.draftClientUpdate(u.orgId, parseProjectId(rawId), u.userId);
  }

  @Post("projects/:projectId/plan")
  async plan(
    @Param("projectId") rawId: string,
    @Body(new ZodValidationPipe(planBodySchema)) body: PlanBodyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireFeature(u.plan, "ai.project-manager");
    this.ensureLlm();
    return this.projectsAi.proposePlan(u.orgId, parseProjectId(rawId), body.prompt, u.userId);
  }

  @Post("projects/:projectId/extract-tasks")
  async extractTasks(
    @Param("projectId") rawId: string,
    @Body(new ZodValidationPipe(extractBodySchema)) body: ExtractBodyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireFeature(u.plan, "ai.project-manager");
    this.ensureLlm();
    return this.projectsAi.extractTasks(u.orgId, parseProjectId(rawId), body.text, u.userId);
  }

  @Post("projects/:projectId/ask")
  async ask(
    @Param("projectId") rawId: string,
    @Body(new ZodValidationPipe(askBodySchema)) body: AskBodyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireFeature(u.plan, "ai.project-manager");
    this.ensureLlm();
    return this.projectsAi.ask(u.orgId, parseProjectId(rawId), body.question, u.userId);
  }

  @Post("projects/:projectId/tickets/draft/suggest-title")
  async suggestDraftTitle(
    @Param("projectId") rawPid: string,
    @Body(new ZodValidationPipe(draftTicketBodySchema)) body: DraftTicketBodyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireFeature(u.plan, "ai.ticket-insights");
    this.ensureLlm();
    return this.ticketAi.suggestTitleFromDraft(
      u.orgId,
      u.userId,
      parsePositiveInt(rawPid, "projectId"),
      body,
    );
  }

  @Post("projects/:projectId/tickets/draft/improve-description")
  async improveDraftDescription(
    @Param("projectId") rawPid: string,
    @Body(new ZodValidationPipe(draftTicketBodySchema)) body: DraftTicketBodyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireFeature(u.plan, "ai.ticket-insights");
    this.ensureLlm();
    return this.ticketAi.improveDescriptionDraft(
      u.orgId,
      u.userId,
      parsePositiveInt(rawPid, "projectId"),
      body,
    );
  }

  @Post("projects/:projectId/tickets/draft/suggest-fields")
  async suggestDraftFields(
    @Param("projectId") rawPid: string,
    @Body(new ZodValidationPipe(draftTicketBodySchema)) body: DraftTicketBodyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireFeature(u.plan, "ai.ticket-insights");
    this.ensureLlm();
    return this.ticketAi.suggestFieldsFromDraft(
      u.orgId,
      u.userId,
      parsePositiveInt(rawPid, "projectId"),
      body,
    );
  }

  @Post("tickets/:projectId/:ticketId/summarize")
  async summarizeTicket(
    @Param("projectId") rawPid: string,
    @Param("ticketId") rawTid: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireFeature(u.plan, "ai.ticket-insights");
    this.ensureLlm();
    return this.ticketAi.summarizeTicket(u.orgId, u.userId, parsePositiveInt(rawPid, "projectId"), parsePositiveInt(rawTid, "ticketId"));
  }

  @Post("tickets/:projectId/:ticketId/summarize-comments")
  async summarizeTicketComments(
    @Param("projectId") rawPid: string,
    @Param("ticketId") rawTid: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireFeature(u.plan, "ai.ticket-insights");
    this.ensureLlm();
    return this.ticketAi.summarizeComments(
      u.orgId,
      u.userId,
      parsePositiveInt(rawPid, "projectId"),
      parsePositiveInt(rawTid, "ticketId"),
    );
  }

  @Post("tickets/:projectId/:ticketId/improve-description")
  async improveTicketDescription(
    @Param("projectId") rawPid: string,
    @Param("ticketId") rawTid: string,
    @Body(new ZodValidationPipe(improveDescriptionBodySchema)) body: ImproveDescriptionBodyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireFeature(u.plan, "ai.ticket-insights");
    this.ensureLlm();
    return this.ticketAi.improveDescription(u.orgId, u.userId, parsePositiveInt(rawPid, "projectId"), parsePositiveInt(rawTid, "ticketId"), body.draft);
  }

  @Post("tickets/:projectId/:ticketId/suggest-subtasks")
  async suggestTicketSubtasks(
    @Param("projectId") rawPid: string,
    @Param("ticketId") rawTid: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireFeature(u.plan, "ai.ticket-insights");
    this.ensureLlm();
    return this.ticketAi.suggestSubtasks(u.orgId, u.userId, parsePositiveInt(rawPid, "projectId"), parsePositiveInt(rawTid, "ticketId"));
  }

  @Post("tickets/:projectId/:ticketId/generate-checklist")
  async generateTicketChecklist(
    @Param("projectId") rawPid: string,
    @Param("ticketId") rawTid: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireFeature(u.plan, "ai.ticket-insights");
    this.ensureLlm();
    return this.ticketAi.generateChecklist(
      u.orgId,
      u.userId,
      parsePositiveInt(rawPid, "projectId"),
      parsePositiveInt(rawTid, "ticketId"),
    );
  }

  @Post("projects/:projectId/weekly-update")
  async weeklyUpdate(
    @Param("projectId") rawId: string,
    @Body(new ZodValidationPipe(weeklyUpdateBodySchema)) body: WeeklyUpdateBodyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireFeature(u.plan, "ai.project-manager");
    this.ensureLlm();
    return this.projectsAi.weeklyUpdate(u.orgId, parseProjectId(rawId), body.startDate, body.endDate, u.userId);
  }

  @Post("projects/:projectId/meetings/:meetingId/extract-actions")
  async extractMeetingActions(
    @Param("projectId") rawPid: string,
    @Param("meetingId") rawMid: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireFeature(u.plan, "ai.project-manager");
    this.ensureLlm();
    return this.ticketAi.extractMeetingActions(u.orgId, u.userId, parsePositiveInt(rawPid, "projectId"), parsePositiveInt(rawMid, "meetingId"));
  }

  @Post("projects/:projectId/change-impact")
  async changeImpact(
    @Param("projectId") rawId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireFeature(u.plan, "ai.project-manager");
    this.ensureLlm();
    return this.projectsAi.changeImpact(u.orgId, parseProjectId(rawId), u.userId);
  }

  @Post("tickets/:projectId/:ticketId/handoff")
  async ticketHandoff(
    @Param("projectId") rawPid: string,
    @Param("ticketId") rawTid: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireFeature(u.plan, "ai.ticket-insights");
    this.ensureLlm();
    return this.ticketAi.handoffSummary(u.orgId, u.userId, parsePositiveInt(rawPid, "projectId"), parsePositiveInt(rawTid, "ticketId"));
  }
}
