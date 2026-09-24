import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KbWikiAnalyticsService } from "./kb-wiki-analytics.service";
import {
  wikiAnalyticsQuerySchema,
  wikiPageStatsPageSchema,
  wikiStalePagesPageSchema,
  wikiContributorListSchema,
  type WikiAnalyticsQuery,
} from "./dto/kb-wiki-analytics.schemas";

@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller("kb")
export class KbWikiAnalyticsController {
  constructor(private readonly analytics: KbWikiAnalyticsService) {}

  @RequirePermission("kb:analytics:view")
  @Validate({ query: wikiAnalyticsQuerySchema })
  @ResponseSchema(wikiPageStatsPageSchema)
  @Get("wiki/analytics/page-stats")
  pageStats(
    @CurrentUser() user: CurrentUserContext,
    @Query() query: WikiAnalyticsQuery,
  ) {
    return this.analytics.pageStats(user, query);
  }

  @RequirePermission("kb:analytics:view")
  @Validate({ query: wikiAnalyticsQuerySchema })
  @ResponseSchema(wikiStalePagesPageSchema)
  @Get("wiki/analytics/stale-pages")
  stalePages(
    @CurrentUser() user: CurrentUserContext,
    @Query() query: WikiAnalyticsQuery,
  ) {
    return this.analytics.stalePages(user, query);
  }

  @RequirePermission("kb:analytics:view")
  @Validate({ query: wikiAnalyticsQuerySchema })
  @ResponseSchema(wikiContributorListSchema)
  @Get("wiki/analytics/contributors")
  contributorActivity(
    @CurrentUser() user: CurrentUserContext,
    @Query() query: WikiAnalyticsQuery,
  ) {
    return this.analytics.contributorActivity(user, query);
  }
}
