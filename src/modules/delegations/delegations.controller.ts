import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  createDelegationSchema,
  type CreateDelegationInput,
} from "./dto/delegation.schemas";
import { DelegationsService } from "./delegations.service";

@Controller("access/delegations")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class DelegationsController {
  constructor(private readonly service: DelegationsService) {}

  @Get()
  @RequirePermission("hr:employees:view")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.service.list(u.orgId, u.userId);
  }

  @Get("given")
  @RequirePermission("hr:employees:view")
  listGiven(@CurrentUser() u: CurrentUserContext) {
    return this.service.listGiven(u.orgId, u.userId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("hr:employees:manage")
  create(
    @Body(new ZodValidationPipe(createDelegationSchema)) body: CreateDelegationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.create(u, body);
  }

  @Delete(":delegationId")
  @HttpCode(204)
  @RequirePermission("hr:employees:manage")
  revoke(@Param("delegationId") delegationId: string, @CurrentUser() u: CurrentUserContext) {
    return this.service.revoke(u.orgId, delegationId, u);
  }
}
