import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { HrSettingsHubService } from "./hr-settings-hub.service";
import { effectiveRulesQuerySchema, versionsQuerySchema } from "./dto/hr-settings-hub.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import type { EffectiveRulesQuery, VersionsQuery } from "./dto/hr-settings-hub.schemas";
import { effectiveRulesResponseSchema, versionsResponseSchema } from "./dto/hr-settings-hub-response.schemas";

@RequireModule("hr")
@Controller("hr/settings-hub")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrSettingsHubController {
  constructor(private readonly service: HrSettingsHubService) {}

  @Get("effective-rules")
  @ResponseSchema(effectiveRulesResponseSchema)
  @RequirePermission("hr:policies:view")
  @Validate({ query: effectiveRulesQuerySchema })
  getEffectiveRules(
    @Query() query: EffectiveRulesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.getEffectiveRules(u.orgId, query.employeeId, query.date);
  }

  @Get("versions")
  @ResponseSchema(versionsResponseSchema)
  @RequirePermission("hr:policies:view")
  @Validate({ query: versionsQuerySchema })
  getVersions(
    @Query() query: VersionsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.getVersions(u.orgId, query.entity, query.id);
  }
}
