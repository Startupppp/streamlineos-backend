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
import { CustomerReturnsService } from "./customer-returns.service";
import {
  listReturnsSchema, createCustomerReturnSchema, postCustomerReturnSchema,
  type ListReturnsInput, type CreateCustomerReturnInput, type PostCustomerReturnInput,
} from "./dto/inv-returns.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const returnIdParams = z.object({ returnId: z.coerce.number().int().positive() }).strict();

@RequireModule("inventory")
@Controller("inventory/customer-returns")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class CustomerReturnsController {
  constructor(private readonly service: CustomerReturnsService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:customer-returns:manage")
  @Validate({ query: listReturnsSchema })
  list(
    @Query() filters: ListReturnsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.list(u.orgId, filters);
  }

  @Get(":returnId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:customer-returns:manage")
  @Validate({ params: returnIdParams })
  get(
    @Param("returnId", ParseIntPipe) returnId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.get(u.orgId, returnId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:customer-returns:manage")
  @Validate({ body: createCustomerReturnSchema })
  create(
    @Body() body: CreateCustomerReturnInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.create(u.orgId, u.userId, body);
  }

  @Post(":returnId/post")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:customer-returns:manage")
  @HttpCode(HttpStatus.OK)
  @Validate({ params: returnIdParams, body: postCustomerReturnSchema })
  post(
    @Param("returnId", ParseIntPipe) returnId: number,
    @Body() body: PostCustomerReturnInput,
    @Headers("idempotency-key") idempotencyKeyHeader: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!idempotencyKeyHeader) throw new BadRequestException("Idempotency-Key header is required");
    return this.service.post(u.orgId, returnId, u.userId, idempotencyKeyHeader, body);
  }

  @Post(":returnId/cancel")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:customer-returns:manage")
  @HttpCode(HttpStatus.OK)
  @Validate({ params: returnIdParams })
  cancel(
    @Param("returnId", ParseIntPipe) returnId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.cancel(u.orgId, returnId);
  }
}
