import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { HrSettingsHubService } from "./hr-settings-hub.service";
import { effectiveRulesQuerySchema, versionsQuerySchema } from "./dto/hr-settings-hub.schemas";
import type { EffectiveRulesQuery, VersionsQuery } from "./dto/hr-settings-hub.schemas";

@RequireModule("hr")
@Controller("hr/settings-hub")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrSettingsHubController {
  constructor(private readonly service: HrSettingsHubService) {}

  @Get("effective-rules")
  @RequirePermission("hr:policies:view")
  getEffectiveRules(
    @Query(new ZodValidationPipe(effectiveRulesQuerySchema)) query: EffectiveRulesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.getEffectiveRules(u.orgId, query.employeeId, query.date);
  }

  @Get("versions")
  @RequirePermission("hr:policies:view")
  getVersions(
    @Query(new ZodValidationPipe(versionsQuerySchema)) query: VersionsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.getVersions(u.orgId, query.entity, query.id);
  }
}
