import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  ParseIntPipe,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { AccessService } from "../../access/access.service";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { resolveInvSoScope } from "../stock-engine/inventory-scope";
import { SoCoreService } from "./so-core.service";
import { SoFulfillmentService } from "./so-fulfillment.service";
import {
  listSoSchema, createSoSchema, updateSoSchema, reserveSoSchema,
  pickSoSchema, packSoSchema, shipSoSchema, cancelSoSchema,
  type ListSoInput, type CreateSoInput, type UpdateSoInput,
  type ReserveSoInput, type PickSoInput, type PackSoInput,
  type ShipSoInput, type CancelSoInput,
} from "./dto/inv-sales-orders.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";
import { IdempotencyKey } from "../../../common/idempotency/idempotency-key.decorator";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";

const soIdParams = z.object({ soId: z.coerce.number().int().positive() }).strict();

@RequireModule("inventory")
@Controller("inventory/sales-orders")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvSalesOrdersController {
  constructor(
    private readonly soCore: SoCoreService,
    private readonly soFulfillment: SoFulfillmentService,
    private readonly access: AccessService,
  ) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:sales-orders:read")
  @Validate({ query: listSoSchema })
  async list(
    @Query() filters: ListSoInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const scope = await resolveInvSoScope(this.access, u);
    return this.soCore.listSos(u.orgId, filters, scope, u.userId);
  }

  @Get(":soId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:sales-orders:read")
  @Validate({ params: soIdParams })
  get(
    @Param("soId", ParseIntPipe) soId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.soCore.getSo(u.orgId, soId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:sales-orders:create")
  @Idempotent("inventory.sales-order.create")
  @Validate({ body: createSoSchema })
  create(
    @Body() body: CreateSoInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.soCore.createSo(u.orgId, u.userId, body);
  }

  @Patch(":soId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:sales-orders:update")
  @Validate({ params: soIdParams, body: updateSoSchema })
  update(
    @Param("soId", ParseIntPipe) soId: number,
    @Body() body: UpdateSoInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.soCore.updateSo(u.orgId, soId, body);
  }

  @Post(":soId/confirm")
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:sales-orders:confirm")
  @HttpCode(HttpStatus.OK)
  @Validate({ params: soIdParams })
  confirm(
    @IdempotencyKey() idempotencyKey: string,
    @Param("soId", ParseIntPipe) soId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.soCore.confirmSo(u.orgId, soId, u.userId, idempotencyKey);
  }

  @Post(":soId/reserve")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:reserve")
  @HttpCode(HttpStatus.OK)
  @Validate({ params: soIdParams, body: reserveSoSchema })
  reserve(
    @Param("soId", ParseIntPipe) soId: number,
    @Body() body: ReserveSoInput,
    @IdempotencyKey() idempotencyKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.soFulfillment.reserveSo(u.orgId, soId, u.userId, idempotencyKey, body);
  }

  @Post(":soId/pick")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:sales-orders:ship")
  @HttpCode(HttpStatus.OK)
  @Validate({ params: soIdParams, body: pickSoSchema })
  pick(
    @IdempotencyKey() idempotencyKey: string,
    @Param("soId", ParseIntPipe) soId: number,
    @Body() body: PickSoInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.soFulfillment.pickSo(u.orgId, soId, u.userId, body, idempotencyKey);
  }

  @Post(":soId/pack")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:sales-orders:ship")
  @HttpCode(HttpStatus.OK)
  @Validate({ params: soIdParams, body: packSoSchema })
  pack(
    @IdempotencyKey() idempotencyKey: string,
    @Param("soId", ParseIntPipe) soId: number,
    @Body() body: PackSoInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.soFulfillment.packSo(u.orgId, soId, u.userId, body, idempotencyKey);
  }

  @Post(":soId/ship")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:sales-orders:ship")
  @HttpCode(HttpStatus.OK)
  @Validate({ params: soIdParams, body: shipSoSchema })
  ship(
    @Param("soId", ParseIntPipe) soId: number,
    @Body() body: ShipSoInput,
    @IdempotencyKey() idempotencyKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.soFulfillment.shipSo(u.orgId, soId, u.userId, idempotencyKey, body);
  }

  @Post(":soId/invoice")
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:sales-orders:invoice")
  @Idempotent("inventory.sales-order.invoice")
  @HttpCode(HttpStatus.OK)
  @Validate({ params: soIdParams })
  invoice(
    @Param("soId", ParseIntPipe) soId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.soCore.invoiceSo(u.orgId, soId, u.userId);
  }

  @Post(":soId/cancel")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:sales-orders:update")
  @HttpCode(HttpStatus.OK)
  @Validate({ params: soIdParams, body: cancelSoSchema })
  cancel(
    @Param("soId", ParseIntPipe) soId: number,
    @Body() body: CancelSoInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.soCore.cancelSo(u.orgId, soId, u.userId);
  }

  @Get(":soId/atp")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:sales-orders:read")
  @Validate({ params: soIdParams })
  async getAtp(
    @Param("soId", ParseIntPipe) soId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const so = await this.soCore.getSo(u.orgId, soId);
    const variantIds = so.lines.map((l) => l.productVariantId);
    return this.soCore.getAtp(u.orgId, variantIds);
  }
}
