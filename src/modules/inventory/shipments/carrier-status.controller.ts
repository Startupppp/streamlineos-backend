import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { CarrierStatusService } from "./carrier-status.service";
import { carrierStatusSchema, type CarrierStatusInput } from "./dto/carrier-status.schemas";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  recordCarrierStatusResponseSchema,
  refreshTrackingResponseSchema,
  shipmentTimelineResponseSchema,
} from "./dto/shipments-response.schemas";

@RequireModule("inventory")
@Controller("inventory/shipments")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class CarrierStatusController {
  constructor(private readonly carrierStatus: CarrierStatusService) {}

  /**
   * INV-207. Idempotent by the carrier's own event id, and monotonic: an event
   * that would move a shipment backwards is recorded and ignored rather than
   * applied, because carriers deliver OUT_FOR_DELIVERY after DELIVERED often
   * enough that acting on the latest message tells customers their delivered
   * parcel is back on a van.
   */
  @Post("carrier-status")
  @ResponseSchema(recordCarrierStatusResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:shipments:manage")
  recordStatus(
    @Body(new ZodValidationPipe(carrierStatusSchema)) body: CarrierStatusInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.carrierStatus.recordEvent(u.orgId, u.userId, body);
  }

  @Get(":shipmentId/timeline")
  @ResponseSchema(shipmentTimelineResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:shipments:manage")
  timeline(
    @Param("shipmentId", ParseIntPipe) shipmentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.carrierStatus.timeline(u.orgId, shipmentId);
  }

  /**
   * B7, item 2 — ask the carrier where the parcel is, through the adapter
   * contract.
   *
   * Answers rather than throws when there is nobody to ask or the courier is
   * unreachable, because the caller has already shipped the goods and neither
   * fact changes that. `polled: false` is the manual adapter's normal answer and
   * the sheet renders it as "manual tracking", which is the truth this surface
   * used to state as "coming soon".
   */
  @Post(":shipmentId/refresh-tracking")
  @ResponseSchema(refreshTrackingResponseSchema)
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:shipments:manage")
  @HttpCode(HttpStatus.OK)
  refreshTracking(
    @Param("shipmentId", ParseIntPipe) shipmentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.carrierStatus.refreshTracking(u.orgId, u.userId, shipmentId);
  }
}
