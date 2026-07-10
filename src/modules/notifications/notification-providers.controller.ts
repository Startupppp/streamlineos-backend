import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { NotificationProvidersService } from "./notification-providers.service";
import {
  createProviderSchema,
  updateProviderSchema,
  testProviderSchema,
  type CreateProviderInput,
  type UpdateProviderInput,
  type TestProviderInput,
} from "./dto/provider.schemas";

@Controller("notifications/admin/providers")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class NotificationProvidersController {
  constructor(private readonly providers: NotificationProvidersService) {}

  @Get()
  @RequirePermission("notifications:providers:view")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.providers.list(u.orgId);
  }

  @Post()
  @RequirePermission("notifications:providers:manage")
  create(
    @Body(new ZodValidationPipe(createProviderSchema)) body: CreateProviderInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.providers.create(u.orgId, u.userId, body);
  }

  @Patch(":providerId")
  @RequirePermission("notifications:providers:manage")
  update(
    @Param("providerId", ParseIntPipe) providerId: number,
    @Body(new ZodValidationPipe(updateProviderSchema)) body: UpdateProviderInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.providers.update(u.orgId, u.userId, providerId, body);
  }

  @Post(":providerId/test")
  @RequirePermission("notifications:providers:manage")
  test(
    @Param("providerId", ParseIntPipe) providerId: number,
    @Body(new ZodValidationPipe(testProviderSchema)) body: TestProviderInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.providers.test(u.orgId, u.userId, providerId, body);
  }

  @Delete(":providerId")
  @RequirePermission("notifications:providers:manage")
  remove(@Param("providerId", ParseIntPipe) providerId: number, @CurrentUser() u: CurrentUserContext) {
    return this.providers.remove(u.orgId, u.userId, providerId);
  }
}
