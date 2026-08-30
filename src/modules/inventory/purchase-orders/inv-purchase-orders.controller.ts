import {
  BadRequestException, Controller, Get, Post, Patch, Body, Param,
  ParseIntPipe, Query, UseGuards, HttpCode, HttpStatus, Headers,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { AccessService } from "../../access/access.service";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { resolveInvPoScope } from "../stock-engine/inventory-scope";
import { PoService } from "./po.service";
import { GrnService } from "./grn.service";
import {
  listPoSchema, createPoSchema, updatePoSchema, createGrnSchema,
  type ListPoInput, type CreatePoInput, type UpdatePoInput, type CreateGrnInput,
} from "./dto/inv-purchase-orders.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const poIdParams = z.object({ poId: z.coerce.number().int().positive() }).strict();

function requireIdempotencyKey(key: string | undefined): string {
  if (!key) throw new BadRequestException("Idempotency-Key header is required");
  return key;
}

@RequireModule("inventory")
@Controller("inventory/purchase-orders")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvPurchaseOrdersController {
  constructor(
    private readonly pos: PoService,
    private readonly grns: GrnService,
    private readonly access: AccessService,
  ) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:purchase-orders:read")
  async list(
    @Query(new ZodValidationPipe(listPoSchema)) filters: ListPoInput,
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
    return this.pos.getPo(u.orgId, poId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:purchase-orders:create")
  @Idempotent("inventory.purchase-order.create")
  create(
    @Body(new ZodValidationPipe(createPoSchema)) body: CreatePoInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.pos.createPo(u.orgId, u.userId, body);
  }

  @Patch(":poId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:purchase-orders:update")
  @Validate({ params: poIdParams })
  update(
    @Param("poId", ParseIntPipe) poId: number,
    @Body(new ZodValidationPipe(updatePoSchema)) body: UpdatePoInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.pos.updatePo(u.orgId, poId, body);
  }

  @Post(":poId/approve")
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
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:purchase-orders:approve")
  @HttpCode(HttpStatus.OK)
  @Idempotent("inventory.purchase-order.send")
  @Validate({ params: poIdParams })
  send(
    @Param("poId", ParseIntPipe) poId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.pos.sendPo(u.orgId, poId);
  }

  @Post(":poId/close")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:purchase-orders:approve")
  @HttpCode(HttpStatus.OK)
  @Validate({ params: poIdParams })
  close(
    @Param("poId", ParseIntPipe) poId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.pos.closePo(u.orgId, poId);
  }

  @Post(":poId/cancel")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:purchase-orders:approve")
  @HttpCode(HttpStatus.OK)
  @Validate({ params: poIdParams })
  cancel(
    @Param("poId", ParseIntPipe) poId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.pos.cancelPo(u.orgId, poId);
  }

  @Post(":poId/receive")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:purchase-orders:receive")
  @HttpCode(HttpStatus.OK)
  @Validate({ params: poIdParams })
  receiveGoods(
    @Param("poId", ParseIntPipe) poId: number,
    @Body(new ZodValidationPipe(createGrnSchema)) body: CreateGrnInput,
    @Headers("idempotency-key") idempotencyKeyHeader: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const idempotencyKey = requireIdempotencyKey(idempotencyKeyHeader);
    return this.grns.receiveGoods(u.orgId, poId, u.userId, idempotencyKey, body);
  }
}
