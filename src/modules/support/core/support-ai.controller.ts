import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RateLimitGuard } from "../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../common/ratelimit/use-rate-limit.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import { SupportAiService } from "./support-ai.service";
import { SupportAiSettingsService } from "./support-ai-settings.service";
import {
  resolveAiSuggestionSchema,
  translateMessageSchema,
  supportAiReportFiltersSchema,
  updateSupportAiSettingsSchema,
  type ResolveAiSuggestionInput,
  type TranslateMessageInput,
  type SupportAiReportFiltersInput,
  type UpdateSupportAiSettingsInput,
} from "./dto/support.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";

const ticketIdParams = z.object({ ticketId: z.coerce.number().int().positive() }).strict();
const suggestionIdParams = z.object({ suggestionId: z.coerce.number().int().positive() }).strict();

const improveReplyBodySchema = z.object({
  ticketId: z.number().int().positive(),
  content: z.string().trim().min(1).max(10000),
  macroId: z.number().int().positive().optional(),
});

const translateDraftBodySchema = z.object({
  ticketId: z.number().int().positive(),
  language: z.string().trim().min(2).max(50),
  content: z.string().trim().max(10000).optional(),
});

type ImproveReplyBody = z.infer<typeof improveReplyBodySchema>;
type TranslateDraftBody = z.infer<typeof translateDraftBodySchema>;

@RequireModule("support")
@Controller("support")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class SupportAiController {
  constructor(
    private readonly ai: SupportAiService,
    private readonly settingsSvc: SupportAiSettingsService,
    private readonly planLimits: PlanLimitsService,
  ) {}

  @Get("settings")
  @RequirePermission("support:settings:manage")
  getSettings(@CurrentUser() u: CurrentUserContext) {
    return this.settingsSvc.getSettings(u.orgId);
  }

  @Patch("settings")
  @RequirePermission("support:settings:manage")
  @Validate({ body: updateSupportAiSettingsSchema })
  async updateSettings(
    @Body() body: UpdateSupportAiSettingsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (body.confidenceThreshold !== undefined) {
      return this.settingsSvc.updateSettings(u.orgId, body.confidenceThreshold);
    }
    return this.settingsSvc.getSettings(u.orgId);
  }

  @Get(":ticketId/ai/suggestions")
  @RequirePermission("support:tickets:view")
  @Validate({ params: ticketIdParams })
  listSuggestions(@Param("ticketId", ParseIntPipe) ticketId: number, @CurrentUser() u: CurrentUserContext) {
    return this.ai.listSuggestions(u.orgId, ticketId);
  }

  @Post(":ticketId/ai/analyze")
  @BodylessAction()
  @RequirePermission("support:tickets:view")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @HttpCode(200)
  @Validate({ params: ticketIdParams })
  async analyze(@Param("ticketId", ParseIntPipe) ticketId: number, @CurrentUser() u: CurrentUserContext) {
    await this.planLimits.assertFeature(u.orgId, "ai.ticket-insights");
    return this.ai.analyzeTicket(u.orgId, ticketId, u.userId);
  }

  @Post(":ticketId/ai/find-duplicates")
  @BodylessAction()
  @RequirePermission("support:tickets:view")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @HttpCode(200)
  @Validate({ params: ticketIdParams })
  async findDuplicates(@Param("ticketId", ParseIntPipe) ticketId: number, @CurrentUser() u: CurrentUserContext) {
    await this.planLimits.assertFeature(u.orgId, "ai.ticket-insights");
    return this.ai.findDuplicates(u.orgId, ticketId);
  }

  @Post(":ticketId/ai/suggest-kb-articles")
  @BodylessAction()
  @RequirePermission("support:tickets:view")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @HttpCode(200)
  @Validate({ params: ticketIdParams })
  async suggestKbArticles(@Param("ticketId", ParseIntPipe) ticketId: number, @CurrentUser() u: CurrentUserContext) {
    await this.planLimits.assertFeature(u.orgId, "ai.ticket-insights");
    return this.ai.suggestKbArticles(u, ticketId);
  }

  @Post(":ticketId/ai/suggest-reply")
  @BodylessAction()
  @RequirePermission("support:tickets:reply")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @HttpCode(200)
  @Validate({ params: ticketIdParams })
  async suggestReply(@Param("ticketId", ParseIntPipe) ticketId: number, @CurrentUser() u: CurrentUserContext) {
    await this.planLimits.assertFeature(u.orgId, "ai.reply-suggestion");
    return this.ai.suggestReply(u, ticketId);
  }

  @Post(":ticketId/ai/suggest-macro")
  @BodylessAction()
  @RequirePermission("support:tickets:reply")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @HttpCode(200)
  @Validate({ params: ticketIdParams })
  async suggestMacro(@Param("ticketId", ParseIntPipe) ticketId: number, @CurrentUser() u: CurrentUserContext) {
    await this.planLimits.assertFeature(u.orgId, "ai.reply-suggestion");
    return this.ai.suggestMacro(
      u.orgId,
      u.userId,
      ticketId,
      actingMembershipId(u.principal),
    );
  }

  @Post(":ticketId/ai/translate")
  @RequirePermission("support:tickets:view")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @HttpCode(200)
  @Validate({ params: ticketIdParams, body: translateMessageSchema })
  async translateMessage(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body() body: TranslateMessageInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.planLimits.assertFeature(u.orgId, "ai.reply-suggestion");
    return this.ai.translateMessage(u.orgId, ticketId, body.messageId, body.targetLanguage, u.userId);
  }

  @Post(":ticketId/ai/handoff-summary")
  @BodylessAction()
  @RequirePermission("support:tickets:view")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @HttpCode(200)
  @Validate({ params: ticketIdParams })
  async generateHandoffSummary(@Param("ticketId", ParseIntPipe) ticketId: number, @CurrentUser() u: CurrentUserContext) {
    await this.planLimits.assertFeature(u.orgId, "ai.ticket-insights");
    return this.ai.generateHandoffSummary(u, ticketId);
  }

  @Post(":ticketId/ai/root-cause-cluster")
  @BodylessAction()
  @RequirePermission("support:tickets:view")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @HttpCode(200)
  @Validate({ params: ticketIdParams })
  async findRootCauseCluster(@Param("ticketId", ParseIntPipe) ticketId: number, @CurrentUser() u: CurrentUserContext) {
    await this.planLimits.assertFeature(u.orgId, "ai.ticket-insights");
    return this.ai.findRootCauseCluster(u.orgId, ticketId, u.userId);
  }

  @Post("ai/improve-reply")
  @RequirePermission("support:ai:invoke")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @HttpCode(200)
  @Validate({ body: improveReplyBodySchema })
  async improveReply(
    @Body() body: ImproveReplyBody,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.planLimits.assertFeature(u.orgId, "ai.reply-suggestion");
    return this.ai.improveReply(u.orgId, body.ticketId, body.content, u.userId, body.macroId);
  }

  @Post("ai/translate-draft")
  @RequirePermission("support:ai:invoke")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @HttpCode(200)
  @Validate({ body: translateDraftBodySchema })
  async translateDraft(
    @Body() body: TranslateDraftBody,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.planLimits.assertFeature(u.orgId, "ai.reply-suggestion");
    return this.ai.translateDraft(
      u.orgId,
      body.ticketId,
      body.language,
      body.content,
      u.userId,
      actingMembershipId(u.principal),
    );
  }

  @Get("ai/report")
  @RequirePermission("support:ai:view")
  @Validate({ query: supportAiReportFiltersSchema })
  getAiReport(
    @Query() query: SupportAiReportFiltersInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ai.getAiReport(u.orgId, query);
  }

  @Post("ai-suggestions/:suggestionId/resolve")
  @RequirePermission("support:tickets:reply")
  @HttpCode(200)
  @Validate({ params: suggestionIdParams, body: resolveAiSuggestionSchema })
  resolveSuggestion(
    @Param("suggestionId", ParseIntPipe) suggestionId: number,
    @Body() body: ResolveAiSuggestionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ai.resolveSuggestion(u.orgId, suggestionId, u.userId, body);
  }
}
