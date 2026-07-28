import {
  Controller, Get, Post, Patch, Body, Param, ParseIntPipe,
  Query, UseGuards, HttpCode, HttpStatus, Headers, BadRequestException,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { AccessService } from "../access/access.service";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { resolveInvSoScope } from "../inv-stock-engine/inventory-scope";
import { SoCoreService } from "./so-core.service";
import { SoFulfillmentService } from "./so-fulfillment.service";
import {
  listSoSchema, createSoSchema, updateSoSchema, reserveSoSchema,
  pickSoSchema, packSoSchema, shipSoSchema, cancelSoSchema,
  type ListSoInput, type CreateSoInput, type UpdateSoInput,
  type ReserveSoInput, type PickSoInput, type PackSoInput,
  type ShipSoInput, type CancelSoInput,
} from "./dto/inv-sales-orders.schemas";

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
  async list(
    @Query(new ZodValidationPipe(listSoSchema)) filters: ListSoInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const scope = await resolveInvSoScope(this.access, u);
    return this.soCore.listSos(u.orgId, filters, scope, u.userId);
  }

  @Get(":soId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:sales-orders:read")
  get(
    @Param("soId", ParseIntPipe) soId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.soCore.getSo(u.orgId, soId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:sales-orders:create")
  create(
    @Body(new ZodValidationPipe(createSoSchema)) body: CreateSoInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.soCore.createSo(u.orgId, u.userId, body);
  }

  @Patch(":soId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:sales-orders:update")
  update(
    @Param("soId", ParseIntPipe) soId: number,
    @Body(new ZodValidationPipe(updateSoSchema)) body: UpdateSoInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.soCore.updateSo(u.orgId, soId, body);
  }

  @Post(":soId/confirm")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:sales-orders:confirm")
  @HttpCode(HttpStatus.OK)
  confirm(
    @Param("soId", ParseIntPipe) soId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.soCore.confirmSo(u.orgId, soId, u.userId);
  }

  @Post(":soId/reserve")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:reserve")
  @HttpCode(HttpStatus.OK)
  reserve(
    @Param("soId", ParseIntPipe) soId: number,
    @Body(new ZodValidationPipe(reserveSoSchema)) body: ReserveSoInput,
    @Headers("idempotency-key") idempotencyKeyHeader: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!idempotencyKeyHeader) throw new BadRequestException("Idempotency-Key header is required");
    return this.soFulfillment.reserveSo(u.orgId, soId, u.userId, idempotencyKeyHeader, body);
  }

  @Post(":soId/pick")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:sales-orders:ship")
  @HttpCode(HttpStatus.OK)
  pick(
    @Param("soId", ParseIntPipe) soId: number,
    @Body(new ZodValidationPipe(pickSoSchema)) body: PickSoInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.soFulfillment.pickSo(u.orgId, soId, u.userId, body);
  }

  @Post(":soId/pack")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:sales-orders:ship")
  @HttpCode(HttpStatus.OK)
  pack(
    @Param("soId", ParseIntPipe) soId: number,
    @Body(new ZodValidationPipe(packSoSchema)) body: PackSoInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.soFulfillment.packSo(u.orgId, soId, u.userId, body);
  }

  @Post(":soId/ship")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:sales-orders:ship")
  @HttpCode(HttpStatus.OK)
  ship(
    @Param("soId", ParseIntPipe) soId: number,
    @Body(new ZodValidationPipe(shipSoSchema)) body: ShipSoInput,
    @Headers("idempotency-key") idempotencyKeyHeader: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!idempotencyKeyHeader) throw new BadRequestException("Idempotency-Key header is required");
    return this.soFulfillment.shipSo(u.orgId, soId, u.userId, idempotencyKeyHeader, body);
  }

  @Post(":soId/invoice")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:sales-orders:invoice")
  @HttpCode(HttpStatus.OK)
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
  cancel(
    @Param("soId", ParseIntPipe) soId: number,
    @Body(new ZodValidationPipe(cancelSoSchema)) body: CancelSoInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.soCore.cancelSo(u.orgId, soId, u.userId);
  }

  @Get(":soId/atp")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:sales-orders:read")
  async getAtp(
    @Param("soId", ParseIntPipe) soId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const so = await this.soCore.getSo(u.orgId, soId);
    const variantIds = so.lines.map((l) => l.productVariantId);
    return this.soCore.getAtp(u.orgId, variantIds);
  }
}
