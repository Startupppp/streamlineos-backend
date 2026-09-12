import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  UseGuards,
} from "@nestjs/common";
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
import { IdempotencyKey } from "../../../common/idempotency/idempotency-key.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { successSchema } from "../../../common/openapi/response-envelopes";
import {
  listStockLevelsResponseSchema,
  listTransactionsResponseSchema,
  stockAvailabilityResponseSchema,
  listReservationsResponseSchema,
  createReservationResponseSchema,
  stockEngineResultSchema,
} from "./dto/stock-response.schemas";

@RequireModule("inventory")
@Controller("inventory/stock")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvStockController {
  constructor(
    private readonly stock: InvStockService,
    private readonly reservations: InvStockReservationsService,
  ) {}

  @Get()
  @ResponseSchema(listStockLevelsResponseSchema)
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
  @ResponseSchema(listTransactionsResponseSchema)
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
  @ResponseSchema(stockAvailabilityResponseSchema)
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
  @ResponseSchema(listReservationsResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  @Validate({ query: listReservationsSchema })
  listReservations(
    @Query() filters: ListReservationsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reservations.listReservations(u.orgId, u.userId, filters);
  }

  @Post("reserve")
  @ResponseSchema(createReservationResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:reserve")
  @Validate({ body: createReservationSchema })
  createReservation(
    @IdempotencyKey() idempotencyKey: string,
    @Body() body: CreateReservationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reservations.createReservation(u.orgId, u.userId, body, idempotencyKey);
  }

  @Post("release-reservation")
  @ResponseSchema(successSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:reserve")
  @Validate({ body: releaseReservationSchema })
  async releaseReservation(
    @IdempotencyKey() idempotencyKey: string,
    @Body() body: ReleaseReservationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.reservations.releaseReservation(u.orgId, u.userId, body, idempotencyKey);
    return { success: true as const };
  }

  @Post("opening")
  @ResponseSchema(stockEngineResultSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:adjust")
  @Validate({ body: openingStockSchema })
  createOpeningBalance(
    @IdempotencyKey() idempotencyKey: string,
    @Body() body: OpeningStockInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reservations.createOpeningBalance(u.orgId, u.userId, body, idempotencyKey);
  }
}
