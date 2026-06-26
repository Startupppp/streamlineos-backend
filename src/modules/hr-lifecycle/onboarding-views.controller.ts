import { Controller, Get, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { AbilityGuard } from "../../common/rbac/ability.guard";
import { CheckAbility } from "../../common/rbac/check-ability.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { OnboardingViewsService } from "./onboarding-views.service";

@Controller("hr/onboarding-docs")
@UseGuards(JwtAuthGuard)
export class OnboardingViewsController {
  constructor(private readonly onboardingViews: OnboardingViewsService) {}

  @Get("summary")
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "hr:onboarding")
  summary(@CurrentUser() u: CurrentUserContext) {
    return this.onboardingViews.summary(u.orgId);
  }
}
