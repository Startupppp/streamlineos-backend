import { BadRequestException, Controller, Get, Headers, Post, Body, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { InvStockService } from "./inv-stock.service";
import { InvStockReservationsService } from "./inv-stock-reservations.service";
import {
  listStockLevelsSchema, listTransactionsSchema, availabilityQuerySchema,
  listReservationsSchema, createReservationSchema, releaseReservationSchema, openingStockSchema,
  type ListStockLevelsInput, type ListTransactionsInput, type AvailabilityQueryInput,
  type ListReservationsInput, type CreateReservationInput, type ReleaseReservationInput,
  type OpeningStockInput,
} from "./dto/inv-stock.schemas";

@RequireModule("inventory")
@Controller("inventory/stock")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvStockController {
  constructor(
    private readonly stock: InvStockService,
    private readonly reservations: InvStockReservationsService,
  ) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  listLevels(
    @Query(new ZodValidationPipe(listStockLevelsSchema)) filters: ListStockLevelsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.stock.listStockLevels(u.orgId, filters);
  }

  @Get("transactions")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  listTransactions(
    @Query(new ZodValidationPipe(listTransactionsSchema)) filters: ListTransactionsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.stock.listTransactions(u.orgId, filters);
  }

  @Get("availability")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  getAvailability(
    @Query(new ZodValidationPipe(availabilityQuerySchema)) query: AvailabilityQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.stock.getAvailability(u.orgId, query);
  }

  @Get("reservations")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  listReservations(
    @Query(new ZodValidationPipe(listReservationsSchema)) filters: ListReservationsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reservations.listReservations(u.orgId, filters);
  }

  @Post("reserve")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:reserve")
  createReservation(
    @Headers("idempotency-key") idempotencyKey: string,
    @Body(new ZodValidationPipe(createReservationSchema)) body: CreateReservationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!idempotencyKey) throw new BadRequestException("Idempotency-Key header required");
    return this.reservations.createReservation(u.orgId, u.userId, body, idempotencyKey);
  }

  @Post("release-reservation")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:reserve")
  releaseReservation(
    @Body(new ZodValidationPipe(releaseReservationSchema)) body: ReleaseReservationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reservations.releaseReservation(u.orgId, u.userId, body);
  }

  @Post("opening")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:adjust")
  createOpeningBalance(
    @Headers("idempotency-key") idempotencyKey: string,
    @Body(new ZodValidationPipe(openingStockSchema)) body: OpeningStockInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!idempotencyKey) throw new BadRequestException("Idempotency-Key header required");
    return this.reservations.createOpeningBalance(u.orgId, u.userId, body, idempotencyKey);
  }
}
