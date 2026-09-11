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
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { RequireModule } from "../../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../../common/auth/principal";
import { DelegationsService } from "./delegations.service";
import {
  createProxySchema,
  updateProxySchema,
  listProxiesSchema,
  type CreateProxyInput,
  type UpdateProxyInput,
  type ListProxiesInput,
} from "./delegations.dto";
import { Validate } from "../../../../common/validation/validate.decorator";
import { z } from "zod";
import { ResponseSchema, NoContentResponse } from "../../../../common/openapi/zod-operation-contracts"
import { listProxiesResponseSchema, createProxyResponseSchema, updateProxyResponseSchema } from "../dto/governance-response.schemas"

const proxyIdParams = z.object({ proxyId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr/governance/delegations")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrGovernanceDelegationsController {
  constructor(private readonly service: DelegationsService) {}

  @ResponseSchema(listProxiesResponseSchema)
  @Get("my")
  @RequirePermission("hr:workflows:view")
  @Validate({ query: listProxiesSchema })
  async listMy(
    @CurrentUser() user: CurrentUserContext,
    @Query() query: ListProxiesInput,
  ) {
    return this.service.listMy(user, query);
  }

  @ResponseSchema(listProxiesResponseSchema)
  @Get()
  @RequirePermission("hr:workflows:manage")
  @Validate({ query: listProxiesSchema })
  async listOrg(
    @CurrentUser() user: CurrentUserContext,
    @Query() query: ListProxiesInput,
  ) {
    return this.service.listOrg(user.orgId, query);
  }

  @ResponseSchema(createProxyResponseSchema)
  @Post()
  @RequirePermission("hr:workflows:view")
  @Validate({ body: createProxySchema })
  async create(
    @CurrentUser() user: CurrentUserContext,
    @Body() body: CreateProxyInput,
    @Req() req: Request,
  ) {
    return this.service.create(user, body, req.ip);
  }

  @ResponseSchema(updateProxyResponseSchema)
  @Patch(":proxyId")
  @RequirePermission("hr:workflows:view")
  @Validate({ params: proxyIdParams, body: updateProxySchema })
  async update(
    @CurrentUser() user: CurrentUserContext,
    @Param("proxyId", ParseIntPipe) proxyId: number,
    @Body() body: UpdateProxyInput,
    @Req() req: Request,
  ) {
    return this.service.update(user.orgId, proxyId, user.userId, actingMembershipId(user.principal), body, req.ip);
  }

  @NoContentResponse()
  @Delete(":proxyId")
  @RequirePermission("hr:workflows:view")
  @HttpCode(204)
  @Validate({ params: proxyIdParams })
  async revoke(
    @CurrentUser() user: CurrentUserContext,
    @Param("proxyId", ParseIntPipe) proxyId: number,
    @Req() req: Request,
  ) {
    const isAdmin = user.isOrgOwner;
    await this.service.revoke(user.orgId, proxyId, user.userId, actingMembershipId(user.principal), isAdmin, req.ip);
  }
}
