import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { ApiAiTextStream } from "../streaming/ai-text-stream-contract";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { RateLimitGuard } from "../../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../../common/ratelimit/use-rate-limit.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import { NoTenantTransaction } from "../../../../common/tenant/no-tenant-transaction.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { LlmService } from "../providers/llm.service";
import { ProjectsAiService } from "../services/projects-ai.service";
import { TicketInsightsAiService } from "../services/ticket-insights-ai.service";
import { TicketTriageAiService } from "../services/ticket-triage-ai.service";
import { TicketDraftAiService } from "../services/ticket-draft-ai.service";
import { MeetingActionAiService } from "../services/meeting-action-ai.service";
import { PlanLimitsService } from "../../../billing/core/plan-limits.service";
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
import { Validate } from "../../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction } from "../../../../common/openapi/zod-operation-contracts";
import { AiRequestAbortInterceptor, respondWithAiTextStream } from "../streaming";

const projectIdParams = z.object({ projectId: z.string().min(1) }).strict();
const projectIdticketIdParams = z.object({ projectId: z.string().min(1), ticketId: z.string().min(1) }).strict();
const projectIdmeetingIdParams = z.object({ projectId: z.string().min(1), meetingId: z.string().min(1) }).strict();

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
@NoTenantTransaction()
@UseInterceptors(AiRequestAbortInterceptor)
export class ProjectsAiController {
  constructor(
    private readonly llm: LlmService,
    private readonly projectsAi: ProjectsAiService,
    private readonly ticketInsights: TicketInsightsAiService,
    private readonly ticketTriage: TicketTriageAiService,
    private readonly ticketDraft: TicketDraftAiService,
    private readonly meetingAction: MeetingActionAiService,
    private readonly planLimits: PlanLimitsService,
  ) {}

  private ensureLlm(): void {
    if (!this.llm.isConfigured()) throw new ServiceUnavailableException("AI is not configured. Set OPENAI_API_KEY.");
  }

  @Post("projects/:projectId/summary")
  @Validate({ params: projectIdParams })
  @BodylessAction()
  async summary(@Param("projectId") rawId: string, @CurrentUser() u: CurrentUserContext) {
    await this.planLimits.assertFeature(u.orgId, "ai.project-manager");
    this.ensureLlm();
    return this.projectsAi.summarize(u.orgId, parseProjectId(rawId), u.userId);
  }

  @Post("projects/:projectId/risks")
  @Validate({ params: projectIdParams })
  @BodylessAction()
  async risks(@Param("projectId") rawId: string, @CurrentUser() u: CurrentUserContext) {
    await this.planLimits.assertFeature(u.orgId, "ai.project-manager");
    this.ensureLlm();
    return this.projectsAi.detectRisks(u.orgId, parseProjectId(rawId), u.userId);
  }

  @Post("projects/:projectId/client-update")
  @Validate({ params: projectIdParams })
  @BodylessAction()
  async clientUpdate(@Param("projectId") rawId: string, @CurrentUser() u: CurrentUserContext) {
    await this.planLimits.assertFeature(u.orgId, "ai.project-manager");
    this.ensureLlm();
    return this.projectsAi.draftClientUpdate(u.orgId, parseProjectId(rawId), u.userId);
  }

  @Post("projects/:projectId/plan")
  @Validate({ params: projectIdParams, body: planBodySchema })
  async plan(
    @Param("projectId") rawId: string,
    @Body() body: PlanBodyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.planLimits.assertFeature(u.orgId, "ai.project-manager");
    this.ensureLlm();
    return this.projectsAi.proposePlan(u.orgId, parseProjectId(rawId), body.prompt, u.userId);
  }

  @Post("projects/:projectId/extract-tasks")
  @Validate({ params: projectIdParams, body: extractBodySchema })
  async extractTasks(
    @Param("projectId") rawId: string,
    @Body() body: ExtractBodyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.planLimits.assertFeature(u.orgId, "ai.project-manager");
    this.ensureLlm();
    return this.projectsAi.extractTasks(u.orgId, parseProjectId(rawId), body.text, u.userId);
  }

  @Post("projects/:projectId/ask")
  @Validate({ params: projectIdParams, body: askBodySchema })
  async ask(
    @Param("projectId") rawId: string,
    @Body() body: AskBodyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.planLimits.assertFeature(u.orgId, "ai.project-manager");
    this.ensureLlm();
    return this.projectsAi.ask(u.orgId, parseProjectId(rawId), body.question, u.userId);
  }

  @Post("projects/:projectId/tickets/draft/suggest-title")
  @Validate({ params: projectIdParams, body: draftTicketBodySchema })
  async suggestDraftTitle(
    @Param("projectId") rawPid: string,
    @Body() body: DraftTicketBodyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.planLimits.assertFeature(u.orgId, "ai.ticket-insights");
    this.ensureLlm();
    return this.ticketDraft.suggestTitleFromDraft(
      u.orgId,
      u.userId,
      parsePositiveInt(rawPid, "projectId"),
      body,
    );
  }

  @Post("projects/:projectId/tickets/draft/improve-description")
  @Validate({ params: projectIdParams, body: draftTicketBodySchema })
  async improveDraftDescription(
    @Param("projectId") rawPid: string,
    @Body() body: DraftTicketBodyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.planLimits.assertFeature(u.orgId, "ai.ticket-insights");
    this.ensureLlm();
    return this.ticketDraft.improveDescriptionDraft(
      u.orgId,
      u.userId,
      parsePositiveInt(rawPid, "projectId"),
      body,
    );
  }

  @Post("projects/:projectId/tickets/draft/improve-description/stream")
  @HttpCode(200)
  @ApiAiTextStream("Plain-text improved description for the supplied unsaved ticket draft, streamed incrementally. No ticket is persisted; a transport failure before clean EOF leaves an incomplete suggestion.")
  @Validate({ params: projectIdParams, body: draftTicketBodySchema })
  async improveDraftDescriptionStream(
    @Req() req: Request,
    @Param("projectId") rawPid: string,
    @Body() body: DraftTicketBodyInput,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ): Promise<void> {
    await this.planLimits.assertFeature(u.orgId, "ai.ticket-insights");
    this.ensureLlm();
    return respondWithAiTextStream(
      req,
      res,
      {
        feature: "ticket.improve-description",
        orgId: u.orgId,
        route: "POST /ai/projects/:projectId/tickets/draft/improve-description/stream",
      },
      (signal) =>
        this.ticketDraft.streamImproveDescriptionDraft(
          u.orgId,
          u.userId,
          parsePositiveInt(rawPid, "projectId"),
          body,
          signal,
        ),
    );
  }

  @Post("projects/:projectId/tickets/draft/suggest-fields")
  @Validate({ params: projectIdParams, body: draftTicketBodySchema })
  async suggestDraftFields(
    @Param("projectId") rawPid: string,
    @Body() body: DraftTicketBodyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.planLimits.assertFeature(u.orgId, "ai.ticket-insights");
    this.ensureLlm();
    return this.ticketDraft.suggestFieldsFromDraft(
      u.orgId,
      u.userId,
      parsePositiveInt(rawPid, "projectId"),
      body,
    );
  }

  @Post("tickets/:projectId/:ticketId/summarize")
  @Validate({ params: projectIdticketIdParams })
  @BodylessAction()
  async summarizeTicket(
    @Param("projectId") rawPid: string,
    @Param("ticketId") rawTid: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.planLimits.assertFeature(u.orgId, "ai.ticket-insights");
    this.ensureLlm();
    return this.ticketInsights.summarizeTicket(u.orgId, u.userId, parsePositiveInt(rawPid, "projectId"), parsePositiveInt(rawTid, "ticketId"));
  }

  @Post("tickets/:projectId/:ticketId/summarize-comments")
  @Validate({ params: projectIdticketIdParams })
  @BodylessAction()
  async summarizeTicketComments(
    @Param("projectId") rawPid: string,
    @Param("ticketId") rawTid: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.planLimits.assertFeature(u.orgId, "ai.ticket-insights");
    this.ensureLlm();
    return this.ticketInsights.summarizeComments(
      u.orgId,
      u.userId,
      parsePositiveInt(rawPid, "projectId"),
      parsePositiveInt(rawTid, "ticketId"),
    );
  }

  @Post("tickets/:projectId/:ticketId/improve-description")
  @Validate({ params: projectIdticketIdParams, body: improveDescriptionBodySchema })
  async improveTicketDescription(
    @Param("projectId") rawPid: string,
    @Param("ticketId") rawTid: string,
    @Body() body: ImproveDescriptionBodyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.planLimits.assertFeature(u.orgId, "ai.ticket-insights");
    this.ensureLlm();
    return this.ticketInsights.improveDescription(u.orgId, u.userId, parsePositiveInt(rawPid, "projectId"), parsePositiveInt(rawTid, "ticketId"), body.draft);
  }

  @Post("tickets/:projectId/:ticketId/improve-description/stream")
  @HttpCode(200)
  @ApiAiTextStream("Plain-text improved description for the authorized ticket, streamed incrementally. No ticket mutation is performed; a transport failure before clean EOF leaves an incomplete suggestion.")
  @Validate({ params: projectIdticketIdParams, body: improveDescriptionBodySchema })
  async improveTicketDescriptionStream(
    @Req() req: Request,
    @Param("projectId") rawPid: string,
    @Param("ticketId") rawTid: string,
    @Body() body: ImproveDescriptionBodyInput,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ): Promise<void> {
    await this.planLimits.assertFeature(u.orgId, "ai.ticket-insights");
    this.ensureLlm();
    return respondWithAiTextStream(
      req,
      res,
      {
        feature: "ticket.improve-description",
        orgId: u.orgId,
        route: "POST /ai/tickets/:projectId/:ticketId/improve-description/stream",
      },
      (signal) =>
        this.ticketInsights.streamImproveDescription(
          u.orgId,
          u.userId,
          parsePositiveInt(rawPid, "projectId"),
          parsePositiveInt(rawTid, "ticketId"),
          signal,
          body.draft,
        ),
    );
  }

  @Post("tickets/:projectId/:ticketId/suggest-subtasks")
  @Validate({ params: projectIdticketIdParams })
  @BodylessAction()
  async suggestTicketSubtasks(
    @Param("projectId") rawPid: string,
    @Param("ticketId") rawTid: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.planLimits.assertFeature(u.orgId, "ai.ticket-insights");
    this.ensureLlm();
    return this.ticketTriage.suggestSubtasks(u.orgId, u.userId, parsePositiveInt(rawPid, "projectId"), parsePositiveInt(rawTid, "ticketId"));
  }

  @Post("tickets/:projectId/:ticketId/generate-checklist")
  @Validate({ params: projectIdticketIdParams })
  @BodylessAction()
  async generateTicketChecklist(
    @Param("projectId") rawPid: string,
    @Param("ticketId") rawTid: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.planLimits.assertFeature(u.orgId, "ai.ticket-insights");
    this.ensureLlm();
    return this.ticketTriage.generateChecklist(
      u.orgId,
      u.userId,
      parsePositiveInt(rawPid, "projectId"),
      parsePositiveInt(rawTid, "ticketId"),
    );
  }

  @Post("projects/:projectId/weekly-update")
  @Validate({ params: projectIdParams, body: weeklyUpdateBodySchema })
  async weeklyUpdate(
    @Param("projectId") rawId: string,
    @Body() body: WeeklyUpdateBodyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.planLimits.assertFeature(u.orgId, "ai.project-manager");
    this.ensureLlm();
    return this.projectsAi.weeklyUpdate(u.orgId, parseProjectId(rawId), body.startDate, body.endDate, u.userId);
  }

  @Post("projects/:projectId/meetings/:meetingId/extract-actions")
  @Validate({ params: projectIdmeetingIdParams })
  @BodylessAction()
  async extractMeetingActions(
    @Param("projectId") rawPid: string,
    @Param("meetingId") rawMid: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.planLimits.assertFeature(u.orgId, "ai.project-manager");
    this.ensureLlm();
    return this.meetingAction.extractMeetingActions(u.orgId, u.userId, parsePositiveInt(rawPid, "projectId"), parsePositiveInt(rawMid, "meetingId"));
  }

  @Post("projects/:projectId/change-impact")
  @Validate({ params: projectIdParams })
  @BodylessAction()
  async changeImpact(
    @Param("projectId") rawId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.planLimits.assertFeature(u.orgId, "ai.project-manager");
    this.ensureLlm();
    return this.projectsAi.changeImpact(u.orgId, parseProjectId(rawId), u.userId);
  }

  @Post("tickets/:projectId/:ticketId/handoff")
  @Validate({ params: projectIdticketIdParams })
  @BodylessAction()
  async ticketHandoff(
    @Param("projectId") rawPid: string,
    @Param("ticketId") rawTid: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.planLimits.assertFeature(u.orgId, "ai.ticket-insights");
    this.ensureLlm();
    return this.ticketInsights.handoffSummary(u.orgId, u.userId, parsePositiveInt(rawPid, "projectId"), parsePositiveInt(rawTid, "ticketId"));
  }
}
