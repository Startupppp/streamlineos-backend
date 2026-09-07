import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import {
  createDelegationSchema,
  listDelegationsQuerySchema,
  type CreateDelegationInput,
  type ListDelegationsQuery,
} from "./dto/delegation.schemas";
import { DelegationsService } from "./delegations.service";
import { Validate } from "../../common/validation/validate.decorator";
import { ResponseSchema, NoContentResponse } from "../../common/openapi/zod-operation-contracts";
import { delegationsPageSchema, delegationRowSchema } from "./dto/delegation-response.schemas";
import { z } from "zod";

const delegationIdParams = z.object({ delegationId: z.string().min(1) }).strict();

@Controller("access/delegations")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class DelegationsController {
  constructor(private readonly service: DelegationsService) {}

  @Get()
  @RequirePermission("settings:rbac:manage")
  @ResponseSchema(delegationsPageSchema)
  @Validate({ query: listDelegationsQuerySchema })
  list(
    @Query() query: ListDelegationsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.list(u.orgId, u.userId, query);
  }

  @Get("given")
  @RequirePermission("settings:rbac:manage")
  @ResponseSchema(delegationsPageSchema)
  @Validate({ query: listDelegationsQuerySchema })
  listGiven(
    @Query() query: ListDelegationsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listGiven(u.orgId, u.userId, query);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("settings:rbac:manage")
  @ResponseSchema(delegationRowSchema)
  @Validate({ body: createDelegationSchema })
  create(
    @Body() body: CreateDelegationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.create(u, body);
  }

  @Delete(":delegationId")
  @HttpCode(204)
  @RequirePermission("settings:rbac:manage")
  @NoContentResponse()
  @Validate({ params: delegationIdParams })
  revoke(
    @Param("delegationId") delegationId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.revoke(u.orgId, delegationId, u);
  }
}
