import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KbAnalyticsService } from "./kb-analytics.service";
import { rangeSchema, type RangeInput } from "./dto/kb-analytics.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";

@Controller("kb")
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequireModule("kb")
export class KbAnalyticsController {
  constructor(private readonly analytics: KbAnalyticsService) {}

  @Get("analytics/overview")
  @RequirePermission("kb:analytics:view")
  @Validate({ query: rangeSchema })
  async overview(
    @Query() query: RangeInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.analytics.overview(u.orgId, query);
  }

  @Get("analytics/no-results")
  @RequirePermission("kb:analytics:view")
  @Validate({ query: rangeSchema })
  async noResults(
    @Query() query: RangeInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.analytics.noResults(u.orgId, query);
  }

  @Get("analytics/pages")
  @RequirePermission("kb:analytics:view")
  async pages(@CurrentUser() u: CurrentUserContext): Promise<unknown> {
    return await this.analytics.pages(u);
  }

  @Get("analytics/gaps")
  @RequirePermission("kb:analytics:view")
  @Validate({ query: rangeSchema })
  async gaps(
    @Query() query: RangeInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.analytics.gaps(u.orgId, query);
  }

  @Get("analytics/content-gaps")
  @RequirePermission("kb:analytics:view")
  @Validate({ query: rangeSchema })
  async contentGaps(
    @Query() query: RangeInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.analytics.contentGaps(u.orgId, query);
  }
}
