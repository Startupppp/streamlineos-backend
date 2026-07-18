import { Body, Controller, Delete, Param, Get, HttpCode, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  TemporaryAccessService,
  createTemporaryAccessSchema,
  type CreateTemporaryAccessInput,
} from "./temporary-access.service";

@Controller("access/temporary")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class TemporaryAccessController {
  constructor(private readonly service: TemporaryAccessService) {}

  @Get()
  @RequirePermission("hr:employees:view")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.service.list(u.orgId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("hr:employees:manage")
  create(
    @Body(new ZodValidationPipe(createTemporaryAccessSchema)) body: CreateTemporaryAccessInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.create(u, body);
  }

  @Delete(":grantId")
  @HttpCode(204)
  @RequirePermission("hr:employees:manage")
  revoke(@Param("grantId") grantId: string, @CurrentUser() u: CurrentUserContext) {
    return this.service.revoke(u.orgId, Number(grantId));
  }
}
