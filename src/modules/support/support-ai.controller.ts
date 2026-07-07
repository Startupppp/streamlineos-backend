import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { requireFeature } from "../ai/billing/feature-gates";
import { SupportAiService } from "./support-ai.service";
import {
  resolveAiSuggestionSchema,
  translateMessageSchema,
  type ResolveAiSuggestionInput,
  type TranslateMessageInput,
} from "./dto/support.schemas";

@RequireModule("support")
@Controller("support")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class SupportAiController {
  constructor(private readonly ai: SupportAiService) {}

  @Get(":ticketId/ai/suggestions")
  @RequirePermission("support:tickets:view")
  listSuggestions(@Param("ticketId", ParseIntPipe) ticketId: number, @CurrentUser() u: CurrentUserContext) {
    return this.ai.listSuggestions(u.orgId, ticketId);
  }

  @Post(":ticketId/ai/analyze")
  @RequirePermission("support:tickets:view")
  @HttpCode(200)
  analyze(@Param("ticketId", ParseIntPipe) ticketId: number, @CurrentUser() u: CurrentUserContext) {
    requireFeature(u.plan, "ai.ticket-insights");
    return this.ai.analyzeTicket(u.orgId, ticketId);
  }

  @Post(":ticketId/ai/find-duplicates")
  @RequirePermission("support:tickets:view")
  @HttpCode(200)
  findDuplicates(@Param("ticketId", ParseIntPipe) ticketId: number, @CurrentUser() u: CurrentUserContext) {
    requireFeature(u.plan, "ai.ticket-insights");
    return this.ai.findDuplicates(u.orgId, ticketId);
  }

  @Post(":ticketId/ai/suggest-kb-articles")
  @RequirePermission("support:tickets:view")
  @HttpCode(200)
  suggestKbArticles(@Param("ticketId", ParseIntPipe) ticketId: number, @CurrentUser() u: CurrentUserContext) {
    requireFeature(u.plan, "ai.ticket-insights");
    return this.ai.suggestKbArticles(u.orgId, ticketId);
  }

  @Post(":ticketId/ai/suggest-reply")
  @RequirePermission("support:tickets:reply")
  @HttpCode(200)
  suggestReply(@Param("ticketId", ParseIntPipe) ticketId: number, @CurrentUser() u: CurrentUserContext) {
    requireFeature(u.plan, "ai.reply-suggestion");
    return this.ai.suggestReply(u.orgId, ticketId);
  }

  @Post(":ticketId/ai/suggest-macro")
  @RequirePermission("support:tickets:reply")
  @HttpCode(200)
  suggestMacro(@Param("ticketId", ParseIntPipe) ticketId: number, @CurrentUser() u: CurrentUserContext) {
    requireFeature(u.plan, "ai.reply-suggestion");
    return this.ai.suggestMacro(u.orgId, u.userId, ticketId);
  }

  @Post(":ticketId/ai/translate")
  @RequirePermission("support:tickets:view")
  @HttpCode(200)
  translateMessage(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body(new ZodValidationPipe(translateMessageSchema)) body: TranslateMessageInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireFeature(u.plan, "ai.reply-suggestion");
    return this.ai.translateMessage(u.orgId, ticketId, body.messageId, body.targetLanguage);
  }

  @Post(":ticketId/ai/handoff-summary")
  @RequirePermission("support:tickets:view")
  @HttpCode(200)
  generateHandoffSummary(@Param("ticketId", ParseIntPipe) ticketId: number, @CurrentUser() u: CurrentUserContext) {
    requireFeature(u.plan, "ai.ticket-insights");
    return this.ai.generateHandoffSummary(u.orgId, ticketId);
  }

  @Post(":ticketId/ai/root-cause-cluster")
  @RequirePermission("support:tickets:view")
  @HttpCode(200)
  findRootCauseCluster(@Param("ticketId", ParseIntPipe) ticketId: number, @CurrentUser() u: CurrentUserContext) {
    requireFeature(u.plan, "ai.ticket-insights");
    return this.ai.findRootCauseCluster(u.orgId, ticketId);
  }

  @Post("ai-suggestions/:suggestionId/resolve")
  @RequirePermission("support:tickets:reply")
  @HttpCode(200)
  resolveSuggestion(
    @Param("suggestionId", ParseIntPipe) suggestionId: number,
    @Body(new ZodValidationPipe(resolveAiSuggestionSchema)) body: ResolveAiSuggestionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ai.resolveSuggestion(u.orgId, suggestionId, u.userId, body);
  }
}
