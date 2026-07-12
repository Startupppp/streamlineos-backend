import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { InsightsService } from "./insights.service";
import { insightsQuerySchema, type InsightsQuery } from "./dto/insights.schemas";

@RequireModule("accounting")
@Controller("accounting/insights")
@UseGuards(JwtAuthGuard)
export class InsightsController {
  constructor(private readonly insights: InsightsService) {}

  @Get("anomalies")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:read")
  getAnomalies(
    @Query(new ZodValidationPipe(insightsQuerySchema)) query: InsightsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.insights.getAnomalies(u.orgId, query);
  }

  @Get("digest")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:read")
  getDigest(@CurrentUser() u: CurrentUserContext) {
    return this.insights.getDigest(u.orgId);
  }
}
