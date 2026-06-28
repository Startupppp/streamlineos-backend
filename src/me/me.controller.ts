import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../common/auth/backend-claims";
<<<<<<< HEAD
import { PermissionGuard } from "../modules/access/permission.guard";
import { RequirePermission } from "../modules/access/require-permission.decorator";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { AccessService } from "../modules/access/access.service";
import type { AccessSnapshot } from "../modules/access/access.types";
import { MeService, changePasswordSchema, forceChangePasswordSchema, setupPasswordSchema, type ChangePasswordInput, type ForceChangePasswordInput, type SetupPasswordInput } from "./me.service";
import { updateProfileSchema, type UpdateProfileInput } from "./dto/me.schemas";
=======
import { AuthService, type AccessBootstrap } from "../modules/auth/auth.service";
>>>>>>> 8268f32a22460c71f19892e240ad061afc54b8c8

@Controller("me")
@UseGuards(PermissionGuard)
export class MeController {
<<<<<<< HEAD
  constructor(
    private readonly access: AccessService,
    private readonly meService: MeService,
  ) {}
=======
  constructor(private readonly authService: AuthService) {}
>>>>>>> 8268f32a22460c71f19892e240ad061afc54b8c8

  @Get()
  me(@CurrentUser() user: CurrentUserContext): CurrentUserContext {
    return user;
  }

  @Get("access")
<<<<<<< HEAD
  getAccess(@CurrentUser() u: CurrentUserContext): Promise<AccessSnapshot> {
    return this.access.getAccessSnapshot(u.orgId, u.userId, u);
=======
  access(@CurrentUser() user: CurrentUserContext): Promise<AccessBootstrap> {
    return this.authService.getAccessBootstrap(user.userId, user.orgId);
>>>>>>> 8268f32a22460c71f19892e240ad061afc54b8c8
  }

  @Get("protected")
  @RequirePermission("crm:leads:delete")
  protected(@CurrentUser() user: CurrentUserContext): { ok: true; userId: string } {
    return { ok: true, userId: user.userId };
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

  @Patch("change-password")
  changePassword(
    @Body(new ZodValidationPipe(changePasswordSchema)) body: ChangePasswordInput,
    @CurrentUser() user: CurrentUserContext,
  ): Promise<{ success: true }> {
    return this.meService.changePassword(user.userId, body);
  }

  @Patch("force-change-password")
  forceChangePassword(
    @Body(new ZodValidationPipe(forceChangePasswordSchema)) body: ForceChangePasswordInput,
    @CurrentUser() user: CurrentUserContext,
  ): Promise<{ success: true }> {
    return this.meService.forceChangePassword(user.userId, body);
  }

  @Patch("setup-password")
  setupPassword(
    @Body(new ZodValidationPipe(setupPasswordSchema)) body: SetupPasswordInput,
    @CurrentUser() user: CurrentUserContext,
  ): Promise<{ success: true }> {
    return this.meService.setupPassword(user.userId, body.password);
  }

  @Get("login-history")
  getLoginHistory(
    @Query("page") page = 1,
    @Query("limit") limit = 20,
    @CurrentUser() u: CurrentUserContext,
  ): ReturnType<MeService["getLoginHistory"]> {
    return this.meService.getLoginHistory(u.userId, Number(page), Math.min(Number(limit), 100));
  }

  @Get("devices")
  getDevices(@CurrentUser() u: CurrentUserContext): ReturnType<MeService["getDevices"]> {
    return this.meService.getDevices(u.userId);
  }

  @Delete("devices/:deviceId")
  deleteDevice(
    @Param("deviceId") deviceId: string,
    @CurrentUser() u: CurrentUserContext,
  ): ReturnType<MeService["deleteDevice"]> {
    return this.meService.deleteDevice(u.userId, deviceId);
  }

  @Post("devices/:deviceId/trust")
  @HttpCode(200)
  trustDevice(
    @Param("deviceId") deviceId: string,
    @CurrentUser() u: CurrentUserContext,
  ): ReturnType<MeService["trustDevice"]> {
    return this.meService.trustDevice(u.userId, deviceId);
  }

  @Get("auth-analytics")
  getAuthAnalytics(@CurrentUser() u: CurrentUserContext): ReturnType<MeService["getAuthAnalytics"]> {
    return this.meService.getAuthAnalytics(u.userId);
  }

  @Get("connected-accounts")
  getConnectedAccounts(@CurrentUser() u: CurrentUserContext) {
    return this.meService.getConnectedAccounts(u.userId);
  }

  @Delete("connected-accounts")
  unlinkProvider(
    @Body() body: { provider: string },
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.meService.unlinkProvider(u.userId, body.provider);
  }
}
