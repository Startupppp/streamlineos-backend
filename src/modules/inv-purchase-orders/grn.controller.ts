import {
  Controller, Get, Post, Body, Param,
  ParseIntPipe, Query, UseGuards, HttpCode, HttpStatus, Headers,
  BadRequestException,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { GrnService } from "./grn.service";
import {
  listGrnSchema, reverseGrnSchema,
  type ListGrnInput, type ReverseGrnInput,
} from "./dto/inv-purchase-orders.schemas";

@RequireModule("inventory")
@Controller("inventory/goods-receipts")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class GrnController {
  constructor(private readonly grns: GrnService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:purchase-orders:read")
  list(
    @Query(new ZodValidationPipe(listGrnSchema)) filters: ListGrnInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.grns.listGrns(u.orgId, filters);
  }

  @Get(":grnId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:purchase-orders:read")
  get(
    @Param("grnId", ParseIntPipe) grnId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.grns.getGrn(u.orgId, grnId);
  }

  @Post(":grnId/reverse")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:purchase-orders:receive")
  @HttpCode(HttpStatus.OK)
  reverse(
    @Param("grnId", ParseIntPipe) grnId: number,
    @Body(new ZodValidationPipe(reverseGrnSchema)) body: ReverseGrnInput,
    @Headers("idempotency-key") idempotencyKeyHeader: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!idempotencyKeyHeader) throw new BadRequestException("Idempotency-Key header is required");
    return this.grns.reverseGrn(u.orgId, grnId, u.userId, idempotencyKeyHeader, body);
  }
}
