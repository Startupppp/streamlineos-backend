import { BadRequestException, Controller, Get, Headers, Param, ParseIntPipe, Post, Body, Query, UseGuards } from "@nestjs/common";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { AccessService } from "../../access/access.service";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { resolveInvStockScope } from "../stock-engine/inventory-scope";
import { InvStockTransfersService } from "./inv-stock-transfers.service";
import {
  listTransfersSchema, createTransferSchema, completeTransferSchema,
  type ListTransfersInput, type CreateTransferInput, type CompleteTransferInput,
} from "./dto/inv-stock.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const transferIdParams = z.object({ transferId: z.coerce.number().int().positive() }).strict();

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
  @Validate({ query: listTransfersSchema })
  async listTransfers(
    @Query() filters: ListTransfersInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const scope = await resolveInvStockScope(this.access, u);
    return this.transfers.listTransfers(u.orgId, filters, scope, u.userId);
  }

  @Get(":transferId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  @Validate({ params: transferIdParams })
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
  @Validate({ body: createTransferSchema })
  createTransfer(
    @Body() body: CreateTransferInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.transfers.createTransfer(u.orgId, u.userId, body);
  }

  @Post(":transferId/reserve")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:transfer")
  @Validate({ params: transferIdParams })
  reserveTransfer(
    @Headers("idempotency-key") idempotencyKey: string,
    @Param("transferId", ParseIntPipe) transferId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!idempotencyKey) throw new BadRequestException("Idempotency-Key header required");
    return this.transfers.reserveTransfer(u.orgId, u.userId, transferId);
  }

  @Post(":transferId/dispatch")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:transfer")
  @Validate({ params: transferIdParams })
  dispatchTransfer(
    @Headers("idempotency-key") idempotencyKey: string,
    @Param("transferId", ParseIntPipe) transferId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!idempotencyKey) throw new BadRequestException("Idempotency-Key header required");
    return this.transfers.dispatchTransfer(u.orgId, u.userId, transferId, idempotencyKey);
  }

  @Post(":transferId/complete")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:transfer")
  @Validate({ params: transferIdParams, body: completeTransferSchema })
  completeTransfer(
    @Headers("idempotency-key") idempotencyKey: string,
    @Param("transferId", ParseIntPipe) transferId: number,
    @Body() body: CompleteTransferInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!idempotencyKey) throw new BadRequestException("Idempotency-Key header required");
    return this.transfers.completeTransfer(u.orgId, u.userId, transferId, body, idempotencyKey);
  }

  @Post(":transferId/cancel")
  @Idempotent("inventory.stock-transfer.cancel")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:transfer")
  @Validate({ params: transferIdParams })
  cancelTransfer(
    @Param("transferId", ParseIntPipe) transferId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.transfers.cancelTransfer(u.orgId, u.userId, transferId);
  }
}
