import { Body, Controller, Get, Patch, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../common/auth/jwt-auth.guard";
import { CurrentUser } from "../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../common/auth/backend-claims";
import { PermissionGuard } from "../modules/access/permission.guard";
import { RequirePermission } from "../modules/access/require-permission.decorator";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { AccessService } from "../modules/access/access.service";
import type { AccessSnapshot } from "../modules/access/access.types";
import { MeService, changePasswordSchema, type ChangePasswordInput } from "./me.service";
import { updateProfileSchema, type UpdateProfileInput } from "./dto/me.schemas";

@Controller("me")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class MeController {
  constructor(
    private readonly access: AccessService,
    private readonly meService: MeService,
  ) {}

  @Get()
  me(@CurrentUser() user: CurrentUserContext): CurrentUserContext {
    return user;
  }

  @Get("access")
  getAccess(@CurrentUser() u: CurrentUserContext): Promise<AccessSnapshot> {
    return this.access.getAccessSnapshot(u.orgId, u.userId, u);
  }

  @Get("protected")
  @RequirePermission("crm:leads:delete")
  protected(@CurrentUser() user: CurrentUserContext): { ok: true; userId: string } {
    return { ok: true, userId: user.userId };
  }

  @Patch("change-password")
  changePassword(
    @Body(new ZodValidationPipe(changePasswordSchema)) body: ChangePasswordInput,
    @CurrentUser() user: CurrentUserContext,
  ): Promise<{ success: true }> {
    return this.meService.changePassword(user.userId, body);
  }
}
