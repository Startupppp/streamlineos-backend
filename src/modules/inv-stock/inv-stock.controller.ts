import { Controller, Get, Post, Body, Param, ParseIntPipe, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { requireAuthorize } from "../../common/access/authorize";
import { InvStockService } from "./inv-stock.service";
import {
  listStockLevelsSchema, listTransactionsSchema, listAdjustmentsSchema, createAdjustmentSchema, createTransferSchema, completeTransferSchema,
  type ListStockLevelsInput, type ListTransactionsInput, type ListAdjustmentsInput, type CreateAdjustmentInput, type CreateTransferInput, type CompleteTransferInput,
} from "./dto/inv-stock.schemas";

@Controller("inventory/stock")
@UseGuards(JwtAuthGuard)
export class InvStockController {
  constructor(private readonly stock: InvStockService) {}

  @Get()
  listLevels(
    @Query(new ZodValidationPipe(listStockLevelsSchema)) filters: ListStockLevelsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireAuthorize(u, { permission: "inventory:products:view", requiredModule: "inventory" });
    return this.stock.listStockLevels(u.orgId, filters);
  }

  @Get("transactions")
  listTransactions(
    @Query(new ZodValidationPipe(listTransactionsSchema)) filters: ListTransactionsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireAuthorize(u, { permission: "inventory:products:view", requiredModule: "inventory" });
    return this.stock.listTransactions(u.orgId, filters);
  }

  @Get("adjustments")
  listAdjustments(
    @Query(new ZodValidationPipe(listAdjustmentsSchema)) filters: ListAdjustmentsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireAuthorize(u, { permission: "inventory:products:view", requiredModule: "inventory" });
    return this.stock.listAdjustments(u.orgId, filters);
  }

  @Post("adjustments")
  createAdjustment(
    @Body(new ZodValidationPipe(createAdjustmentSchema)) body: CreateAdjustmentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireAuthorize(u, { permission: "inventory:products:manage", requiredModule: "inventory" });
    return this.stock.createAdjustment(u.orgId, u.userId, body);
  }

  @Get("transfers")
  listTransfers(@CurrentUser() u: CurrentUserContext) {
    requireAuthorize(u, { permission: "inventory:orders:view", requiredModule: "inventory" });
    return this.stock.listTransfers(u.orgId);
  }

  @Get("transfers/:transferId")
  getTransfer(@Param("transferId", ParseIntPipe) transferId: number, @CurrentUser() u: CurrentUserContext) {
    requireAuthorize(u, { permission: "inventory:orders:view", requiredModule: "inventory" });
    return this.stock.getTransfer(u.orgId, transferId);
  }

  @Post("transfers")
  createTransfer(
    @Body(new ZodValidationPipe(createTransferSchema)) body: CreateTransferInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireAuthorize(u, { permission: "inventory:orders:manage", requiredModule: "inventory" });
    return this.stock.createTransfer(u.orgId, u.userId, body);
  }

  @Post("transfers/:transferId/complete")
  completeTransfer(
    @Param("transferId", ParseIntPipe) transferId: number,
    @Body(new ZodValidationPipe(completeTransferSchema)) body: CompleteTransferInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireAuthorize(u, { permission: "inventory:orders:manage", requiredModule: "inventory" });
    return this.stock.completeTransfer(u.orgId, u.userId, transferId, body);
  }
}
