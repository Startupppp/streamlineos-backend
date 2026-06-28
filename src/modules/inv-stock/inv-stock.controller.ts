import { Controller, Get, Post, Body, Param, ParseIntPipe, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { requireAuthorize } from "../../common/access/authorize";
import { InvStockService } from "./inv-stock.service";
import {
  listStockLevelsSchema, listTransactionsSchema, listAdjustmentsSchema, createAdjustmentSchema,
  createTransferSchema, completeTransferSchema, listTransfersSchema,
  type ListStockLevelsInput, type ListTransactionsInput, type ListAdjustmentsInput,
  type CreateAdjustmentInput, type CreateTransferInput, type CompleteTransferInput, type ListTransfersInput,
} from "./dto/inv-stock.schemas";

@Controller("inventory/stock")
@UseGuards(JwtAuthGuard)
export class InvStockController {
  constructor(private readonly stock: InvStockService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  listLevels(
    @Query(new ZodValidationPipe(listStockLevelsSchema)) filters: ListStockLevelsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireAuthorize(u, { permission: "inventory:products:view", requiredModule: "inventory" });
    return this.stock.listStockLevels(u.orgId, filters);
  }

  @Get("transactions")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  listTransactions(
    @Query(new ZodValidationPipe(listTransactionsSchema)) filters: ListTransactionsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireAuthorize(u, { permission: "inventory:products:view", requiredModule: "inventory" });
    return this.stock.listTransactions(u.orgId, filters);
  }

  @Get("adjustments")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  listAdjustments(
    @Query(new ZodValidationPipe(listAdjustmentsSchema)) filters: ListAdjustmentsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireAuthorize(u, { permission: "inventory:products:view", requiredModule: "inventory" });
    return this.stock.listAdjustments(u.orgId, filters);
  }

  @Post("adjustments")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:adjust")
  createAdjustment(
    @Body(new ZodValidationPipe(createAdjustmentSchema)) body: CreateAdjustmentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireAuthorize(u, { permission: "inventory:products:manage", requiredModule: "inventory" });
    return this.stock.createAdjustment(u.orgId, u.userId, body);
  }

  @Get("transfers")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  listTransfers(
    @Query(new ZodValidationPipe(listTransfersSchema)) filters: ListTransfersInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireAuthorize(u, { permission: "inventory:orders:view", requiredModule: "inventory" });
    return this.stock.listTransfers(u.orgId, filters);
  }

  @Get("transfers/:transferId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  getTransfer(@Param("transferId", ParseIntPipe) transferId: number, @CurrentUser() u: CurrentUserContext) {
    requireAuthorize(u, { permission: "inventory:orders:view", requiredModule: "inventory" });
    return this.stock.getTransfer(u.orgId, transferId);
  }

  @Post("transfers")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:transfer")
  createTransfer(
    @Body(new ZodValidationPipe(createTransferSchema)) body: CreateTransferInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireAuthorize(u, { permission: "inventory:orders:manage", requiredModule: "inventory" });
    return this.stock.createTransfer(u.orgId, u.userId, body);
  }

  @Post("transfers/:transferId/complete")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:transfer")
  completeTransfer(
    @Param("transferId", ParseIntPipe) transferId: number,
    @Body(new ZodValidationPipe(completeTransferSchema)) body: CompleteTransferInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireAuthorize(u, { permission: "inventory:orders:manage", requiredModule: "inventory" });
    return this.stock.completeTransfer(u.orgId, u.userId, transferId, body);
  }
}
