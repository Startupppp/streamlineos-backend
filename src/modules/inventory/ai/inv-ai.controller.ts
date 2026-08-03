import { Controller, Get, Post, Patch, Param, ParseIntPipe, Query, Body, UseGuards, HttpCode, HttpStatus } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RateLimitGuard } from "../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../common/ratelimit/use-rate-limit.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { InvAiService } from "./inv-ai.service";
import {
  listInsightsSchema,
  updateInsightStatusSchema,
  type ListInsightsInput,
  type UpdateInsightStatusInput,
} from "./dto/ai-insights.schemas";

@RequireModule("inventory")
@Controller("inventory/ai")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvAiController {
  constructor(private readonly aiService: InvAiService) {}

  @Get("insights")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:reports:read")
  listInsights(
    @Query(new ZodValidationPipe(listInsightsSchema)) filters: ListInsightsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.aiService.listInsights(u.orgId, filters);
  }

  @Post("insights/generate")
  @UseGuards(PermissionGuard, RateLimitGuard)
  @RequirePermission("inventory:ai:manage")
  @UseRateLimit("ai:invoke")
  @HttpCode(HttpStatus.OK)
  generateInsights(@CurrentUser() u: CurrentUserContext) {
    return this.aiService.generateInsights(u.orgId);
  }

  @Patch("insights/:insightId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:ai:manage")
  updateInsightStatus(
    @Param("insightId", ParseIntPipe) insightId: number,
    @Body(new ZodValidationPipe(updateInsightStatusSchema)) body: UpdateInsightStatusInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.aiService.updateInsightStatus(u.orgId, insightId, body);
  }
}
