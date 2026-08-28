import { Body, Controller, Get, Param, ParseIntPipe, Post, UseGuards } from "@nestjs/common";
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
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:shipments:manage")
  recordStatus(
    @Body(new ZodValidationPipe(carrierStatusSchema)) body: CarrierStatusInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.carrierStatus.recordEvent(u.orgId, u.userId, body);
  }

  @Get(":shipmentId/timeline")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:shipments:manage")
  timeline(
    @Param("shipmentId", ParseIntPipe) shipmentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.carrierStatus.timeline(u.orgId, shipmentId);
  }
}
