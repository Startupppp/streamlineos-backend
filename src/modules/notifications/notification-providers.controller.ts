import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { NotificationProvidersService } from "./notification-providers.service";
import {
  createProviderSchema,
  updateProviderSchema,
  testProviderSchema,
  type CreateProviderInput,
  type UpdateProviderInput,
  type TestProviderInput,
} from "./dto/provider.schemas";
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";

const providerIdParams = z.object({ providerId: z.coerce.number().int().positive() }).strict();

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
  @HttpCode(201)
  @RequirePermission("notifications:providers:manage")
  @Validate({ body: createProviderSchema })
  create(
    @Body() body: CreateProviderInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.providers.create(u.orgId, u.userId, body);
  }

  @Patch(":providerId")
  @RequirePermission("notifications:providers:manage")
  @Validate({ params: providerIdParams, body: updateProviderSchema })
  update(
    @Param("providerId", ParseIntPipe) providerId: number,
    @Body() body: UpdateProviderInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.providers.update(u.orgId, u.userId, providerId, body);
  }

  @Post(":providerId/test")
  @RequirePermission("notifications:providers:manage")
  @Validate({ params: providerIdParams, body: testProviderSchema })
  test(
    @Param("providerId", ParseIntPipe) providerId: number,
    @Body() body: TestProviderInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.providers.test(u.orgId, u.userId, providerId, body);
  }

  @Delete(":providerId")
  @RequirePermission("notifications:providers:manage")
  @Validate({ params: providerIdParams })
  remove(@Param("providerId", ParseIntPipe) providerId: number, @CurrentUser() u: CurrentUserContext) {
    return this.providers.remove(u.orgId, u.userId, providerId);
  }
}
