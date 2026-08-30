import { BadRequestException, Controller, Get, Headers, Post, Body, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { InvStockService } from "./inv-stock.service";
import { InvStockReservationsService } from "./inv-stock-reservations.service";
import {
  listStockLevelsSchema, listTransactionsSchema, availabilityQuerySchema,
  listReservationsSchema, createReservationSchema, releaseReservationSchema, openingStockSchema,
  type ListStockLevelsInput, type ListTransactionsInput, type AvailabilityQueryInput,
  type ListReservationsInput, type CreateReservationInput, type ReleaseReservationInput,
  type OpeningStockInput,
} from "./dto/inv-stock.schemas";
import { Validate } from "../../../common/validation/validate.decorator";

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
  @Validate({ query: listStockLevelsSchema })
  listLevels(
    @Query() filters: ListStockLevelsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.stock.listStockLevels(u.orgId, u.userId, filters);
  }

  @Get("transactions")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  @Validate({ query: listTransactionsSchema })
  listTransactions(
    @Query() filters: ListTransactionsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.stock.listTransactions(u.orgId, u.userId, filters);
  }

  @Get("availability")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  @Validate({ query: availabilityQuerySchema })
  getAvailability(
    @Query() query: AvailabilityQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.stock.getAvailability(u.orgId, u.userId, query);
  }

  @Get("reservations")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  @Validate({ query: listReservationsSchema })
  listReservations(
    @Query() filters: ListReservationsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reservations.listReservations(u.orgId, filters);
  }

  @Post("reserve")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:reserve")
  @Validate({ body: createReservationSchema })
  createReservation(
    @Headers("idempotency-key") idempotencyKey: string,
    @Body() body: CreateReservationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!idempotencyKey) throw new BadRequestException("Idempotency-Key header required");
    return this.reservations.createReservation(u.orgId, u.userId, body);
  }

  @Post("release-reservation")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:reserve")
  @Validate({ body: releaseReservationSchema })
  releaseReservation(
    @Body() body: ReleaseReservationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reservations.releaseReservation(u.orgId, u.userId, body);
  }

  @Post("opening")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:adjust")
  @Validate({ body: openingStockSchema })
  createOpeningBalance(
    @Headers("idempotency-key") idempotencyKey: string,
    @Body() body: OpeningStockInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!idempotencyKey) throw new BadRequestException("Idempotency-Key header required");
    return this.reservations.createOpeningBalance(u.orgId, u.userId, body, idempotencyKey);
  }
}
