import {
  Controller, Get, Post, Body, Param,
  ParseIntPipe, Query, UseGuards, HttpCode, HttpStatus, Headers, BadRequestException,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { CustomerReturnsService } from "./customer-returns.service";
import {
  listReturnsSchema, createCustomerReturnSchema, postCustomerReturnSchema,
  type ListReturnsInput, type CreateCustomerReturnInput, type PostCustomerReturnInput,
} from "./dto/inv-returns.schemas";

@RequireModule("inventory")
@Controller("inventory/customer-returns")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class CustomerReturnsController {
  constructor(private readonly service: CustomerReturnsService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:customer-returns:manage")
  list(
    @Query(new ZodValidationPipe(listReturnsSchema)) filters: ListReturnsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.list(u.orgId, u.userId, filters);
  }

  @Get(":returnId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:customer-returns:manage")
  get(
    @Param("returnId", ParseIntPipe) returnId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.get(u.orgId, returnId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:customer-returns:manage")
  create(
    @Body(new ZodValidationPipe(createCustomerReturnSchema)) body: CreateCustomerReturnInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.create(u.orgId, u.userId, body);
  }

  @Post(":returnId/post")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:customer-returns:manage")
  @HttpCode(HttpStatus.OK)
  post(
    @Param("returnId", ParseIntPipe) returnId: number,
    @Body(new ZodValidationPipe(postCustomerReturnSchema)) body: PostCustomerReturnInput,
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
  cancel(
    @Param("returnId", ParseIntPipe) returnId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.cancel(u.orgId, returnId);
  }
}
