import { Controller, Get, Param, ParseIntPipe, Post, Body, Query, UseGuards } from "@nestjs/common";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { AccessService } from "../../access/access.service";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { IdempotencyKey } from "../../../common/idempotency/idempotency-key.decorator";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { resolveInvStockScope } from "../stock-engine/inventory-scope";
import { InvStockTransfersService } from "./inv-stock-transfers.service";
import {
  listTransfersSchema, createTransferSchema, completeTransferSchema,
  type ListTransfersInput, type CreateTransferInput, type CompleteTransferInput,
} from "./dto/inv-stock.schemas";

@RequireModule("inventory")
@Controller("inventory/stock/transfers")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvStockTransfersController {
  constructor(
    private readonly transfers: InvStockTransfersService,
    private readonly access: AccessService,
  ) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  async listTransfers(
    @Query(new ZodValidationPipe(listTransfersSchema)) filters: ListTransfersInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const scope = await resolveInvStockScope(this.access, u);
    return this.transfers.listTransfers(u.orgId, filters, scope, u.userId);
  }

  @Get(":transferId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  getTransfer(
    @Param("transferId", ParseIntPipe) transferId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.transfers.getTransfer(u.orgId, transferId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:transfer")
  @Idempotent("inventory.stock.transfer.create")
  createTransfer(
    @Body(new ZodValidationPipe(createTransferSchema)) body: CreateTransferInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.transfers.createTransfer(u.orgId, u.userId, body);
  }

  @Post(":transferId/reserve")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:transfer")
  reserveTransfer(
    @IdempotencyKey() idempotencyKey: string,
    @Param("transferId", ParseIntPipe) transferId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.transfers.reserveTransfer(u.orgId, u.userId, transferId, idempotencyKey);
  }

  @Post(":transferId/dispatch")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:transfer")
  dispatchTransfer(
    @IdempotencyKey() idempotencyKey: string,
    @Param("transferId", ParseIntPipe) transferId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.transfers.dispatchTransfer(u.orgId, u.userId, transferId, idempotencyKey);
  }

  @Post(":transferId/complete")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:transfer")
  completeTransfer(
    @IdempotencyKey() idempotencyKey: string,
    @Param("transferId", ParseIntPipe) transferId: number,
    @Body(new ZodValidationPipe(completeTransferSchema)) body: CompleteTransferInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.transfers.completeTransfer(u.orgId, u.userId, transferId, body, idempotencyKey);
  }

  @Post(":transferId/cancel")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:transfer")
  cancelTransfer(
    @IdempotencyKey() idempotencyKey: string,
    @Param("transferId", ParseIntPipe) transferId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.transfers.cancelTransfer(u.orgId, u.userId, transferId, idempotencyKey);
  }
}
