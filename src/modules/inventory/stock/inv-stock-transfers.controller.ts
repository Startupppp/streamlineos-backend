import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Body,
  Query,
  UseGuards,
} from "@nestjs/common";
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
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { IdempotencyKey } from "../../../common/idempotency/idempotency-key.decorator";

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
  @Validate({ body: createTransferSchema })
  createTransfer(
    @IdempotencyKey() idempotencyKey: string,
    @Body() body: CreateTransferInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.transfers.createTransfer(u.orgId, u.userId, body, idempotencyKey);
  }

  @Post(":transferId/reserve")
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:transfer")
  @Validate({ params: transferIdParams })
  reserveTransfer(
    @IdempotencyKey() idempotencyKey: string,
    @Param("transferId", ParseIntPipe) transferId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.transfers.reserveTransfer(u.orgId, u.userId, transferId, idempotencyKey);
  }

  @Post(":transferId/dispatch")
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:transfer")
  @Validate({ params: transferIdParams })
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
  @Validate({ params: transferIdParams, body: completeTransferSchema })
  completeTransfer(
    @IdempotencyKey() idempotencyKey: string,
    @Param("transferId", ParseIntPipe) transferId: number,
    @Body() body: CompleteTransferInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.transfers.completeTransfer(u.orgId, u.userId, transferId, body, idempotencyKey);
  }

  @Post(":transferId/cancel")
  @BodylessAction()
  @Idempotent("inventory.stock-transfer.cancel")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:transfer")
  @Validate({ params: transferIdParams })
  cancelTransfer(
    @IdempotencyKey() idempotencyKey: string,
    @Param("transferId", ParseIntPipe) transferId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.transfers.cancelTransfer(u.orgId, u.userId, transferId, idempotencyKey);
  }
}
