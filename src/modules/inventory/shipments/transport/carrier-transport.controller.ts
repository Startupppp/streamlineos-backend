import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../../common/rbac/module.guard";
import { RequireModule } from "../../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { Validate } from "../../../../common/validation/validate.decorator";
import { BodylessAction, ResponseSchema } from "../../../../common/openapi/zod-operation-contracts";
import { CarrierTransportService } from "./carrier-transport.service";
import { CarrierCredentialsService } from "./carrier-credentials.service";
import {
  carrierDeliveriesQuerySchema,
  carrierOperationsQuerySchema,
  setCarrierCredentialsSchema,
  type CarrierDeliveriesQuery,
  type CarrierOperationsQuery,
  type SetCarrierCredentialsInput,
} from "../dto/carrier-transport.schemas";
import {
  carrierCredentialsResponseSchema,
  carrierOperationResultSchema,
  listCarrierDeliveriesResponseSchema,
  listCarrierOperationsResponseSchema,
} from "../dto/carrier-transport-response.schemas";

const shipmentIdParams = z
  .object({ shipmentId: z.coerce.number().int().positive() })
  .strict();
const carrierIdParams = z.object({ carrierId: z.coerce.number().int().positive() }).strict();

/**
 * INV-26 — the carrier surface an operator and an administrator actually use.
 *
 * Everything here is gated on `inventory:shipments:manage`, which already
 * exists and already governs the rest of the shipment surface. A new permission
 * key would have to be added to the frontend catalogue in the other repository
 * on the same day or `useCan` returns false forever, and nothing about booking
 * a courier is a different authority from shipping the goods.
 *
 * The three write routes answer with an outcome rather than throwing on a
 * carrier failure, because the goods have already been packed and a courier's
 * API being down does not change that. A 500 here would invite a caller to undo
 * something that must not be undone.
 */
@RequireModule("inventory")
@Controller("inventory")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class CarrierTransportController {
  constructor(
    private readonly transport: CarrierTransportService,
    private readonly credentials: CarrierCredentialsService,
  ) {}

  /**
   * Install or rotate this tenant's courier account.
   *
   * A separate route from `PATCH /inventory/carriers/:carrierId` on purpose:
   * that handler audits `before`/`after` of the whole row, and routing a secret
   * through it would put a decryptable copy of every rotation in the audit log.
   * What comes back here is a masked hint and a boolean, never a value.
   */
  @Put("carriers/:carrierId/credentials")
  @ResponseSchema(carrierCredentialsResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:shipments:manage")
  @Validate({ params: carrierIdParams, body: setCarrierCredentialsSchema })
  setCredentials(
    @Param("carrierId", ParseIntPipe) carrierId: number,
    @Body() body: SetCarrierCredentialsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.credentials.setCredentials(u.orgId, u.userId, carrierId, body);
  }

  /** Put the consignment on the courier's books. */
  @Post("shipments/:shipmentId/carrier/book")
  @BodylessAction()
  @ResponseSchema(carrierOperationResultSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:shipments:manage")
  @HttpCode(HttpStatus.OK)
  @Validate({ params: shipmentIdParams })
  book(
    @Param("shipmentId", ParseIntPipe) shipmentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.transport.book(u.orgId, u.userId, shipmentId);
  }

  /** Ask for the label. Separate from booking because couriers make it later. */
  @Post("shipments/:shipmentId/carrier/label")
  @BodylessAction()
  @ResponseSchema(carrierOperationResultSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:shipments:manage")
  @HttpCode(HttpStatus.OK)
  @Validate({ params: shipmentIdParams })
  fetchLabel(
    @Param("shipmentId", ParseIntPipe) shipmentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.transport.fetchLabel(u.orgId, u.userId, shipmentId);
  }

  /** Ask the courier where the parcel is, through the transport adapter. */
  @Post("shipments/:shipmentId/carrier/track")
  @BodylessAction()
  @ResponseSchema(carrierOperationResultSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:shipments:manage")
  @HttpCode(HttpStatus.OK)
  @Validate({ params: shipmentIdParams })
  track(
    @Param("shipmentId", ParseIntPipe) shipmentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.transport.track(u.orgId, u.userId, shipmentId);
  }

  /**
   * The operator's queue: every carrier call and what it did.
   *
   * This is the ticket's acceptance criterion as an endpoint. Filter on
   * `outcome=rejected` for bookings a courier refused and
   * `outcome=unavailable` for couriers that were unreachable; leave it off on
   * a shipment sheet, where the successes are the context that makes a failure
   * legible.
   */
  @Get("carriers/operations")
  @ResponseSchema(listCarrierOperationsResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:shipments:manage")
  @Validate({ query: carrierOperationsQuerySchema })
  operations(@Query() query: CarrierOperationsQuery, @CurrentUser() u: CurrentUserContext) {
    return this.transport.operations(u.orgId, query);
  }

  /**
   * The dead-letter queue: callbacks that verified and could not be applied.
   *
   * A courier reporting a tracking number this organisation does not hold is
   * almost always a real problem — a parcel booked outside the system, or a
   * shipment deleted while in flight — and it is invisible anywhere else,
   * because by definition it touched no shipment.
   */
  @Get("carriers/deliveries")
  @ResponseSchema(listCarrierDeliveriesResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:shipments:manage")
  @Validate({ query: carrierDeliveriesQuerySchema })
  deliveries(@Query() query: CarrierDeliveriesQuery, @CurrentUser() u: CurrentUserContext) {
    return this.transport.deliveries(u.orgId, query);
  }
}
