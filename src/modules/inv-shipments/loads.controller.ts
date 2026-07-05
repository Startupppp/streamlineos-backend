import { Controller, Get, Post, Param, Body, Query, ParseIntPipe, UseGuards, HttpCode, HttpStatus } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { LoadsService } from "./loads.service";
import {
  listLoadsQuerySchema,
  createLoadSchema,
  dispatchLoadSchema,
  closeLoadSchema,
  type ListLoadsQueryInput,
  type CreateLoadInput,
  type DispatchLoadInput,
  type CloseLoadInput,
} from "./dto/shipments.schemas";

@RequireModule("inventory")
@Controller("inventory/loads")
@UseGuards(JwtAuthGuard)
export class LoadsController {
  constructor(private readonly svc: LoadsService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:loads:manage")
  list(
    @Query(new ZodValidationPipe(listLoadsQuerySchema)) query: ListLoadsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.list(u.orgId, query);
  }

  @Get(":loadId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:loads:manage")
  findOne(
    @Param("loadId", ParseIntPipe) loadId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.findOne(u.orgId, loadId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:loads:manage")
  create(
    @Body(new ZodValidationPipe(createLoadSchema)) body: CreateLoadInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.create(u.orgId, u.userId, body);
  }

  @Post(":loadId/dispatch")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:loads:manage")
  @HttpCode(HttpStatus.OK)
  dispatch(
    @Param("loadId", ParseIntPipe) loadId: number,
    @Body(new ZodValidationPipe(dispatchLoadSchema)) body: DispatchLoadInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.dispatch(u.orgId, u.userId, loadId, body);
  }

  @Post(":loadId/close")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:loads:manage")
  @HttpCode(HttpStatus.OK)
  close(
    @Param("loadId", ParseIntPipe) loadId: number,
    @Body(new ZodValidationPipe(closeLoadSchema)) body: CloseLoadInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.close(u.orgId, u.userId, loadId, body);
  }

  @Post(":loadId/cancel")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:loads:manage")
  @HttpCode(HttpStatus.OK)
  cancel(
    @Param("loadId", ParseIntPipe) loadId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.cancel(u.orgId, u.userId, loadId);
  }
}
