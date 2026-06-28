import { Controller, Get, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { OnboardingViewsService } from "./onboarding-views.service";

@Controller("hr/onboarding-docs")
@UseGuards(JwtAuthGuard)
export class OnboardingViewsController {
  constructor(private readonly onboardingViews: OnboardingViewsService) {}

  @Get("summary")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:onboarding:manage")
  summary(@CurrentUser() u: CurrentUserContext) {
    return this.onboardingViews.summary(u.orgId);
  }
}
