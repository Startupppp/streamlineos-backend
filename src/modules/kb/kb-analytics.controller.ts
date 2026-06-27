import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { AbilityGuard } from "../../common/rbac/ability.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { CheckAbility } from "../../common/rbac/check-ability.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { KbAnalyticsService } from "./kb-analytics.service";
import { rangeSchema, type RangeInput } from "./dto/kb-analytics.schemas";

@Controller("kb")
@UseGuards(JwtAuthGuard, ModuleGuard, AbilityGuard)
@RequireModule("kb")
export class KbAnalyticsController {
  constructor(private readonly analytics: KbAnalyticsService) {}

  @Get("analytics/overview")
  @CheckAbility("view", "kb:analytics")
  overview(
    @Query(new ZodValidationPipe(rangeSchema)) query: RangeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.analytics.overview(u.orgId, query);
  }

  @Get("analytics/no-results")
  @CheckAbility("view", "kb:analytics")
  noResults(
    @Query(new ZodValidationPipe(rangeSchema)) query: RangeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.analytics.noResults(u.orgId, query);
  }

  @Get("verification/queue")
  @CheckAbility("manage", "kb:articles")
  verificationQueue(@CurrentUser() u: CurrentUserContext) {
    return this.analytics.verificationQueue(u.orgId);
  }
}
