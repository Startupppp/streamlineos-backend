import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KbAnalyticsService } from "./kb-analytics.service";
import {
  rangeSchema,
  overviewQuerySchema,
  pageAnalyticsQuerySchema,
  type RangeInput,
  type OverviewQueryInput,
  type PageAnalyticsQueryInput,
} from "./dto/kb-analytics.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  kbAnalyticsOverviewSchema,
  kbAnalyticsNoResultsSchema,
  kbAnalyticsPagesSchema,
  kbAnalyticsGapsSchema,
  kbAnalyticsContentGapsSchema,
  kbAnalyticsCitationReuseSchema,
  kbAnalyticsReviewSlaSchema,
} from "./dto/kb-helpcenter-response.schemas";

@Controller("kb")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class KbAnalyticsController {
  constructor(private readonly analytics: KbAnalyticsService) {}

  @Get("analytics/overview")
  @RequirePermission("kb:analytics:view")
  @Validate({ query: overviewQuerySchema })
  @ResponseSchema(kbAnalyticsOverviewSchema)
  async overview(
    @Query() query: OverviewQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.analytics.overview(u.orgId, query);
  }

  @Get("analytics/no-results")
  @RequirePermission("kb:analytics:view")
  @Validate({ query: rangeSchema })
  @ResponseSchema(kbAnalyticsNoResultsSchema)
  async noResults(
    @Query() query: RangeInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.analytics.noResults(u.orgId, query);
  }

  @Get("analytics/pages")
  @RequirePermission("kb:analytics:view")
  @Validate({ query: pageAnalyticsQuerySchema })
  @ResponseSchema(kbAnalyticsPagesSchema)
  async pages(
    @Query() query: PageAnalyticsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.analytics.pages(u, query);
  }

  @Get("analytics/gaps")
  @RequirePermission("kb:analytics:view")
  @Validate({ query: rangeSchema })
  @ResponseSchema(kbAnalyticsGapsSchema)
  async gaps(
    @Query() query: RangeInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.analytics.gaps(u.orgId, query);
  }

  @Get("analytics/content-gaps")
  @RequirePermission("kb:analytics:view")
  @Validate({ query: rangeSchema })
  @ResponseSchema(kbAnalyticsContentGapsSchema)
  async contentGaps(
    @Query() query: RangeInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.analytics.contentGaps(u.orgId, query);
  }

  @Get("analytics/citation-reuse")
  @RequirePermission("kb:analytics:view")
  @Validate({ query: rangeSchema })
  @ResponseSchema(kbAnalyticsCitationReuseSchema)
  async citationReuse(
    @Query() query: RangeInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.analytics.citationReuse(u.orgId, query);
  }

  @Get("analytics/review-sla")
  @RequirePermission("kb:analytics:view")
  @Validate({ query: rangeSchema })
  @ResponseSchema(kbAnalyticsReviewSlaSchema)
  async reviewSla(
    @Query() query: RangeInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.analytics.reviewSla(u.orgId, query);
  }
}
