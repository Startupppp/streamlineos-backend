import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { DelegationsService } from "./delegations.service";
import {
  createProxySchema,
  updateProxySchema,
  listProxiesSchema,
  type CreateProxyInput,
  type UpdateProxyInput,
  type ListProxiesInput,
} from "./delegations.dto";

@RequireModule("hr")
@Controller("hr/governance/delegations")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class DelegationsController {
  constructor(private readonly service: DelegationsService) {}

  @Get("my")
  @RequirePermission("hr:employees:view")
  async listMy(
    @CurrentUser() user: CurrentUserContext,
    @Query(new ZodValidationPipe(listProxiesSchema)) query: ListProxiesInput,
  ) {
    return this.service.listMy(user.orgId, user.userId, query);
  }

  @Get()
  @RequirePermission("hr:employees:manage")
  async listOrg(
    @CurrentUser() user: CurrentUserContext,
    @Query(new ZodValidationPipe(listProxiesSchema)) query: ListProxiesInput,
  ) {
    return this.service.listOrg(user.orgId, query);
  }

  @Post()
  @RequirePermission("hr:employees:view")
  async create(
    @CurrentUser() user: CurrentUserContext,
    @Body(new ZodValidationPipe(createProxySchema)) body: CreateProxyInput,
    @Req() req: Request,
  ) {
    return this.service.create(user.orgId, user.userId, body, req.ip);
  }

  @Patch(":proxyId")
  @RequirePermission("hr:employees:view")
  async update(
    @CurrentUser() user: CurrentUserContext,
    @Param("proxyId", ParseIntPipe) proxyId: number,
    @Body(new ZodValidationPipe(updateProxySchema)) body: UpdateProxyInput,
    @Req() req: Request,
  ) {
    return this.service.update(user.orgId, proxyId, user.userId, body, req.ip);
  }

  @Delete(":proxyId")
  @RequirePermission("hr:employees:view")
  @HttpCode(204)
  async revoke(
    @CurrentUser() user: CurrentUserContext,
    @Param("proxyId", ParseIntPipe) proxyId: number,
    @Req() req: Request,
  ) {
    const isAdmin = user.isOrgOwner;
    await this.service.revoke(user.orgId, proxyId, user.userId, isAdmin, req.ip);
  }
}
