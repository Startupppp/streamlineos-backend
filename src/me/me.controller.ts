import { Body, Controller, Get, Patch, Query } from "@nestjs/common";
import { CurrentUser } from "../common/auth/current-user.decorator";
import { AuthCtx } from "../common/auth/auth-context.decorator";
import type { AuthContext } from "../common/auth/auth-context";
import { Universal } from "../common/auth/universal.decorator";
import { AllowWithoutMfa } from "../common/auth/allow-without-mfa.decorator";
import type { CurrentUserContext } from "../common/auth/backend-claims";
import { Validate } from "../common/validation/validate.decorator";
import { ResponseSchema } from "../common/openapi/zod-operation-contracts";
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
import {
  meResponseSchema,
  accessSnapshotSchema,
  orgDisplaySchema,
  profileResponseSchema,
  updateProfileResponseSchema,
  loginHistoryResponseSchema,
  authAnalyticsSchema,
} from "./dto/me-response.schemas";

@Controller("me")
export class MeController {
  constructor(
    private readonly access: AccessService,
    private readonly meService: MeService,
  ) {}

  @Get()
  @Universal()
  @AllowWithoutMfa()
  @ResponseSchema(meResponseSchema)
  me(@CurrentUser() user: CurrentUserContext): CurrentUserContext {
    return user;
  }

  @Get("access")
  @Universal()
  @AllowWithoutMfa()
  @ResponseSchema(accessSnapshotSchema)
  getAccess(
    @CurrentUser() u: CurrentUserContext,
    @AuthCtx() authCtx: AuthContext,
  ): Promise<AccessSnapshot> {
    return this.access.getAccessSnapshot(u.orgId, u.userId, u, authCtx);
  }

  @Get("org-display")
  @Universal()
  @AllowWithoutMfa()
  @ResponseSchema(orgDisplaySchema)
  getOrgDisplay(@CurrentUser() user: CurrentUserContext): Promise<OrgDisplay> {
    return this.meService.getOrgDisplay(user.orgId);
  }

  @Get("profile")
  @Universal()
  @ResponseSchema(profileResponseSchema)
  getProfile(@CurrentUser() user: CurrentUserContext): ReturnType<MeService["getProfile"]> {
    return this.meService.getProfile(user.userId, user.orgId ?? null);
  }

  @Patch("profile")
  @Universal()
  @Validate({ body: updateProfileSchema })
  @ResponseSchema(updateProfileResponseSchema)
  updateProfile(
    @Body() body: UpdateProfileInput,
    @CurrentUser() user: CurrentUserContext,
  ): Promise<{ success: true }> {
    return this.meService.updateProfile(user.userId, user.orgId ?? null, body);
  }

  @Get("login-history")
  @Universal()
  @Validate({ query: loginHistoryQuerySchema })
  @ResponseSchema(loginHistoryResponseSchema)
  getLoginHistory(
    @Query() query: LoginHistoryQuery,
    @CurrentUser() u: CurrentUserContext,
  ): ReturnType<MeService["getLoginHistory"]> {
    return this.meService.getLoginHistory(u.userId, query.page, query.limit, query.success);
  }

  @Get("auth-analytics")
  @Universal()
  @ResponseSchema(authAnalyticsSchema)
  getAuthAnalytics(@CurrentUser() u: CurrentUserContext): ReturnType<MeService["getAuthAnalytics"]> {
    return this.meService.getAuthAnalytics(u.userId);
  }

}
