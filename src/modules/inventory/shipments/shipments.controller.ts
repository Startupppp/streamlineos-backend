import { Controller, Get, Post, Patch, Param, Body, Query, Headers, ParseIntPipe, UseGuards, HttpCode, HttpStatus, BadRequestException } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { ShipmentsService } from "./shipments.service";
import {
  listShipmentsQuerySchema,
  createShipmentSchema,
  updateShipmentSchema,
  shipActionSchema,
  type ListShipmentsQueryInput,
  type CreateShipmentInput,
  type UpdateShipmentInput,
  type ShipActionInput,
} from "./dto/shipments.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";

const shipmentIdParams = z.object({ shipmentId: z.coerce.number().int().positive() }).strict();

@RequireModule("inventory")
@Controller("inventory/shipments")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class ShipmentsController {
  constructor(private readonly svc: ShipmentsService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:shipments:manage")
  @Validate({ query: listShipmentsQuerySchema })
  list(
    @Query() query: ListShipmentsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.list(u.orgId, query);
  }

  @Get(":shipmentId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:shipments:manage")
  @Validate({ params: shipmentIdParams })
  findOne(
    @Param("shipmentId", ParseIntPipe) shipmentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.findOne(u.orgId, shipmentId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:shipments:manage")
  @Validate({ body: createShipmentSchema })
  create(
    @Body() body: CreateShipmentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.create(u.orgId, u.userId, body);
  }

  @Patch(":shipmentId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:shipments:manage")
  @Validate({ params: shipmentIdParams, body: updateShipmentSchema })
  update(
    @Param("shipmentId", ParseIntPipe) shipmentId: number,
    @Body() body: UpdateShipmentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.update(u.orgId, u.userId, shipmentId, body);
  }

  @Post(":shipmentId/ship")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:shipments:manage")
  @HttpCode(HttpStatus.OK)
  @Validate({ params: shipmentIdParams, body: shipActionSchema })
  ship(
    @Param("shipmentId", ParseIntPipe) shipmentId: number,
    @Body() body: ShipActionInput,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!idempotencyKey) throw new BadRequestException("Idempotency-Key header is required");
    return this.svc.ship(u.orgId, u.userId, shipmentId, body, idempotencyKey);
  }

  @Post(":shipmentId/cancel")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:shipments:manage")
  @HttpCode(HttpStatus.OK)
  @Validate({ params: shipmentIdParams })
  @BodylessAction()
  cancel(
    @Param("shipmentId", ParseIntPipe) shipmentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.cancel(u.orgId, u.userId, shipmentId);
  }
}
