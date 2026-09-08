import { Controller, Get, Post, Patch, Body, Param, ParseIntPipe, Query, UseGuards, HttpCode, HttpStatus, Headers } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { IdempotencyKey } from "../../../common/idempotency/idempotency-key.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { AccessService } from "../../access/access.service";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { resolveInvPoScope } from "../stock-engine/inventory-scope";
import { PoService } from "./po.service";
import { GrnReceiveService } from "./grn-receive.service";
import {
  listPoSchema, createPoSchema, updatePoSchema, createGrnSchema,
  type ListPoInput, type CreatePoInput, type UpdatePoInput, type CreateGrnInput,
} from "./dto/inv-purchase-orders.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";

const poIdParams = z.object({ poId: z.coerce.number().int().positive() }).strict();

@RequireModule("inventory")
@Controller("inventory/purchase-orders")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvPurchaseOrdersController {
  constructor(
    private readonly pos: PoService,
    private readonly grns: GrnReceiveService,
    private readonly access: AccessService,
  ) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:purchase-orders:read")
  @Validate({ query: listPoSchema })
  async list(
    @Query() filters: ListPoInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const scope = await resolveInvPoScope(this.access, u);
    return this.pos.listPos(u.orgId, filters, scope, u.userId);
  }

  @Get(":poId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:purchase-orders:read")
  @Validate({ params: poIdParams })
  get(
    @Param("poId", ParseIntPipe) poId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.pos.getPo(u.orgId, poId, u.userId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:purchase-orders:create")
  @Idempotent("inventory.purchase-order.create")
  @Validate({ body: createPoSchema })
  create(
    @Body() body: CreatePoInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.pos.createPo(u.orgId, u.userId, body);
  }

  @Patch(":poId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:purchase-orders:update")
  @Validate({ params: poIdParams, body: updatePoSchema })
  update(
    @Param("poId", ParseIntPipe) poId: number,
    @Body() body: UpdatePoInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.pos.updatePo(u.orgId, poId, u.userId, body);
  }

  @Post(":poId/approve")
  @BodylessAction()
  @Idempotent("inventory.purchase-order.approve")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:purchase-orders:approve")
  @HttpCode(HttpStatus.OK)
  @Validate({ params: poIdParams })
  approve(
    @Param("poId", ParseIntPipe) poId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.pos.approvePo(u.orgId, poId, u.userId);
  }

  @Post(":poId/send")
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:purchase-orders:approve")
  @HttpCode(HttpStatus.OK)
  @Idempotent("inventory.purchase-order.send")
  @Validate({ params: poIdParams })
  send(
    @Param("poId", ParseIntPipe) poId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.pos.sendPo(u.orgId, poId, u.userId);
  }

  @Post(":poId/close")
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:purchase-orders:approve")
  @Idempotent("inventory.purchase-order.close")
  @HttpCode(HttpStatus.OK)
  @Validate({ params: poIdParams })
  close(
    @Param("poId", ParseIntPipe) poId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.pos.closePo(u.orgId, poId, u.userId);
  }

  @Post(":poId/cancel")
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:purchase-orders:approve")
  @Idempotent("inventory.purchase-order.cancel")
  @HttpCode(HttpStatus.OK)
  @Validate({ params: poIdParams })
  cancel(
    @Param("poId", ParseIntPipe) poId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.pos.cancelPo(u.orgId, poId, u.userId);
  }

  @Post(":poId/receive")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:purchase-orders:receive")
  @HttpCode(HttpStatus.OK)
  @Validate({ params: poIdParams, body: createGrnSchema })
  receiveGoods(
    @Param("poId", ParseIntPipe) poId: number,
    @Body() body: CreateGrnInput,
    @IdempotencyKey() idempotencyKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.grns.receiveGoods(u.orgId, poId, u.userId, idempotencyKey, body);
  }
}
