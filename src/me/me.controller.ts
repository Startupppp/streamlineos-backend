import { Body, Controller, Get, Patch, Query } from "@nestjs/common";
import { CurrentUser } from "../common/auth/current-user.decorator";
import { Universal } from "../common/auth/universal.decorator";
import { AllowWithoutMfa } from "../common/auth/allow-without-mfa.decorator";
import type { CurrentUserContext } from "../common/auth/backend-claims";
import { Validate } from "../common/validation/validate.decorator";
import { AccessService } from "../modules/access/access.service";
import type { AccessSnapshot } from "../modules/access/access.types";
import { MeService } from "./me.service";
import type { OrgDisplay } from "./org-display";
import {
  loginHistoryQuerySchema,
  updateProfileSchema,
  type LoginHistoryQuery,
  type UpdateProfileInput,
} from "./dto/me.schemas";

@Controller("me")
export class MeController {
  constructor(
    private readonly access: AccessService,
    private readonly meService: MeService,
  ) {}

  @Get()
  @Universal()
  @AllowWithoutMfa()
  me(@CurrentUser() user: CurrentUserContext): CurrentUserContext {
    return user;
  }

  @Get("access")
  @Universal()
  @AllowWithoutMfa()
  getAccess(@CurrentUser() u: CurrentUserContext): Promise<AccessSnapshot> {
    return this.access.getAccessSnapshot(u.orgId, u.userId, u);
  }

  /**
   * Ungated on purpose: every member sees money somewhere, and the currency it
   * renders in is not something a permission should withhold. See org-display.ts.
   */
  @Get("org-display")
  @Universal()
  @AllowWithoutMfa()
  getOrgDisplay(@CurrentUser() user: CurrentUserContext): Promise<OrgDisplay> {
    return this.meService.getOrgDisplay(user.orgId);
  }

  @Get("profile")
  @Universal()
  getProfile(@CurrentUser() user: CurrentUserContext): ReturnType<MeService["getProfile"]> {
    return this.meService.getProfile(user.userId, user.orgId ?? null);
  }

  @Patch("profile")
  @Universal()
  @Validate({ body: updateProfileSchema })
  updateProfile(
    @Body() body: UpdateProfileInput,
    @CurrentUser() user: CurrentUserContext,
  ): Promise<{ success: true }> {
    return this.meService.updateProfile(user.userId, user.orgId ?? null, body);
  }

  @Get("login-history")
  @Universal()
  @Validate({ query: loginHistoryQuerySchema })
  getLoginHistory(
    @Query() query: LoginHistoryQuery,
    @CurrentUser() u: CurrentUserContext,
  ): ReturnType<MeService["getLoginHistory"]> {
    return this.meService.getLoginHistory(u.userId, query.page, query.limit, query.success);
  }

  @Get("auth-analytics")
  @Universal()
  getAuthAnalytics(@CurrentUser() u: CurrentUserContext): ReturnType<MeService["getAuthAnalytics"]> {
    return this.meService.getAuthAnalytics(u.userId);
  }

}
