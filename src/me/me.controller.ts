import { Body, Controller, Get, Patch, Query } from "@nestjs/common";
import { CurrentUser } from "../common/auth/current-user.decorator";
import { AllowWithoutMfa } from "../common/auth/allow-without-mfa.decorator";
import type { CurrentUserContext } from "../common/auth/backend-claims";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { AccessService } from "../modules/access/access.service";
import type { AccessSnapshot } from "../modules/access/access.types";
import { MeService } from "./me.service";
import { updateProfileSchema, type UpdateProfileInput } from "./dto/me.schemas";

@Controller("me")
export class MeController {
  constructor(
    private readonly access: AccessService,
    private readonly meService: MeService,
  ) {}

  @Get()
  @AllowWithoutMfa()
  me(@CurrentUser() user: CurrentUserContext): CurrentUserContext {
    return user;
  }

  @Get("access")
  @AllowWithoutMfa()
  getAccess(@CurrentUser() u: CurrentUserContext): Promise<AccessSnapshot> {
    return this.access.getAccessSnapshot(u.orgId, u.userId, u);
  }

  @Get("profile")
  getProfile(@CurrentUser() user: CurrentUserContext): ReturnType<MeService["getProfile"]> {
    return this.meService.getProfile(user.userId);
  }

  @Patch("profile")
  updateProfile(
    @Body(new ZodValidationPipe(updateProfileSchema)) body: UpdateProfileInput,
    @CurrentUser() user: CurrentUserContext,
  ): Promise<{ success: true }> {
    return this.meService.updateProfile(user.userId, body);
  }

  @Get("login-history")
  getLoginHistory(
    @Query("page") page = 1,
    @Query("limit") limit = 20,
    @Query("success") success: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ): ReturnType<MeService["getLoginHistory"]> {
    const successFilter =
      success === "true" ? true : success === "false" ? false : undefined;
    return this.meService.getLoginHistory(u.userId, Number(page), Math.min(Number(limit), 100), successFilter);
  }

  @Get("auth-analytics")
  getAuthAnalytics(@CurrentUser() u: CurrentUserContext): ReturnType<MeService["getAuthAnalytics"]> {
    return this.meService.getAuthAnalytics(u.userId);
  }

}
