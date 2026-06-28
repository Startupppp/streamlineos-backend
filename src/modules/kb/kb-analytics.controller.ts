import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { KbAnalyticsService } from "./kb-analytics.service";
import { rangeSchema, type RangeInput } from "./dto/kb-analytics.schemas";

@Controller("kb")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
@RequireModule("kb")
export class KbAnalyticsController {
  constructor(private readonly analytics: KbAnalyticsService) {}

  @Get("analytics/overview")
  @RequirePermission("kb:analytics:view")
  async overview(
    @Query(new ZodValidationPipe(rangeSchema)) query: RangeInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.analytics.overview(u.orgId, query);
  }

  @Get("analytics/no-results")
  @RequirePermission("kb:analytics:view")
  async noResults(
    @Query(new ZodValidationPipe(rangeSchema)) query: RangeInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.analytics.noResults(u.orgId, query);
  }

  @Get("verification/queue")
  @RequirePermission("kb:articles:manage")
  async verificationQueue(@CurrentUser() u: CurrentUserContext): Promise<unknown> {
    return await this.analytics.verificationQueue(u.orgId);
  }
}
