import {
  Controller, Get, Post, Body, Param,
  ParseIntPipe, Query, UseGuards, HttpCode, HttpStatus, Headers, BadRequestException,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { VendorReturnsService } from "./vendor-returns.service";
import {
  listReturnsSchema, createVendorReturnSchema, postVendorReturnSchema,
  type ListReturnsInput, type CreateVendorReturnInput, type PostVendorReturnInput,
} from "./dto/inv-returns.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  listVendorReturnsResponseSchema,
  getVendorReturnResponseSchema,
} from "./dto/returns-response.schemas";

const returnIdParams = z.object({ returnId: z.coerce.number().int().positive() }).strict();

@RequireModule("inventory")
@Controller("inventory/vendor-returns")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class VendorReturnsController {
  constructor(private readonly service: VendorReturnsService) {}

  @Get()
  @ResponseSchema(listVendorReturnsResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:vendor-returns:manage")
  @Validate({ query: listReturnsSchema })
  list(
    @Query() filters: ListReturnsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.list(u.orgId, filters);
  }

  @Get(":returnId")
  @ResponseSchema(getVendorReturnResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:vendor-returns:manage")
  @Validate({ params: returnIdParams })
  get(
    @Param("returnId", ParseIntPipe) returnId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.get(u.orgId, returnId);
  }

  @Post()
  @ResponseSchema(getVendorReturnResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:vendor-returns:manage")
  @Validate({ body: createVendorReturnSchema })
  create(
    @Body() body: CreateVendorReturnInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.create(u.orgId, u.userId, body);
  }

  @Post(":returnId/post")
  @ResponseSchema(getVendorReturnResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:vendor-returns:manage")
  @HttpCode(HttpStatus.OK)
  @Validate({ params: returnIdParams, body: postVendorReturnSchema })
  post(
    @Param("returnId", ParseIntPipe) returnId: number,
    @Body() body: PostVendorReturnInput,
    @Headers("idempotency-key") idempotencyKeyHeader: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!idempotencyKeyHeader) throw new BadRequestException("Idempotency-Key header is required");
    return this.service.post(u.orgId, returnId, u.userId, idempotencyKeyHeader, body);
  }

  @Post(":returnId/cancel")
  @BodylessAction()
  @ResponseSchema(getVendorReturnResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:vendor-returns:manage")
  @HttpCode(HttpStatus.OK)
  @Validate({ params: returnIdParams })
  cancel(
    @Param("returnId", ParseIntPipe) returnId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.cancel(u.orgId, returnId);
  }
}
