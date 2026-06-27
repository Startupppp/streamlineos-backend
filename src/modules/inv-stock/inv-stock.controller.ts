import { Controller, Get, Post, Body, Param, ParseIntPipe, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { AbilityGuard } from "../../common/rbac/ability.guard";
import { CheckAbility } from "../../common/rbac/check-ability.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
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
  @UseGuards(AbilityGuard)
  @CheckAbility("read", "inventory:stock")
  listLevels(
    @Query(new ZodValidationPipe(listStockLevelsSchema)) filters: ListStockLevelsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.stock.listStockLevels(u.orgId, filters);
  }

  @Get("transactions")
  @UseGuards(AbilityGuard)
  @CheckAbility("read", "inventory:stock")
  listTransactions(
    @Query(new ZodValidationPipe(listTransactionsSchema)) filters: ListTransactionsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.stock.listTransactions(u.orgId, filters);
  }

  @Get("adjustments")
  @UseGuards(AbilityGuard)
  @CheckAbility("read", "inventory:stock")
  listAdjustments(
    @Query(new ZodValidationPipe(listAdjustmentsSchema)) filters: ListAdjustmentsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.stock.listAdjustments(u.orgId, filters);
  }

  @Post("adjustments")
  @UseGuards(AbilityGuard)
  @CheckAbility("adjust", "inventory:stock")
  createAdjustment(
    @Body(new ZodValidationPipe(createAdjustmentSchema)) body: CreateAdjustmentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.stock.createAdjustment(u.orgId, u.userId, body);
  }

  @Get("transfers")
  @UseGuards(AbilityGuard)
  @CheckAbility("read", "inventory:stock")
  listTransfers(@CurrentUser() u: CurrentUserContext) {
    return this.stock.listTransfers(u.orgId);
  }

  @Get("transfers/:transferId")
  @UseGuards(AbilityGuard)
  @CheckAbility("read", "inventory:stock")
  getTransfer(@Param("transferId", ParseIntPipe) transferId: number, @CurrentUser() u: CurrentUserContext) {
    return this.stock.getTransfer(u.orgId, transferId);
  }

  @Post("transfers")
  @UseGuards(AbilityGuard)
  @CheckAbility("transfer", "inventory:stock")
  createTransfer(
    @Body(new ZodValidationPipe(createTransferSchema)) body: CreateTransferInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.stock.createTransfer(u.orgId, u.userId, body);
  }

  @Post("transfers/:transferId/complete")
  @UseGuards(AbilityGuard)
  @CheckAbility("transfer", "inventory:stock")
  completeTransfer(
    @Param("transferId", ParseIntPipe) transferId: number,
    @Body(new ZodValidationPipe(completeTransferSchema)) body: CompleteTransferInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.stock.completeTransfer(u.orgId, u.userId, transferId, body);
  }
}
