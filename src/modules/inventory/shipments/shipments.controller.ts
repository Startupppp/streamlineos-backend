import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  ParseIntPipe,
  UseGuards,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
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
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { IdempotencyKey } from "../../../common/idempotency/idempotency-key.decorator";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import {
  listShipmentsResponseSchema,
  getShipmentResponseSchema,
  invShipmentSchema,
} from "./dto/shipments-response.schemas";

const shipmentIdParams = z.object({ shipmentId: z.coerce.number().int().positive() }).strict();

@RequireModule("inventory")
@Controller("inventory/shipments")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class ShipmentsController {
  constructor(private readonly svc: ShipmentsService) {}

  @Get()
  @ResponseSchema(listShipmentsResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:shipments:manage")
  @Validate({ query: listShipmentsQuerySchema })
  list(
    @Query() query: ListShipmentsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.list(u.orgId, u.userId, query);
  }

  @Get(":shipmentId")
  @ResponseSchema(getShipmentResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:shipments:manage")
  @Validate({ params: shipmentIdParams })
  findOne(
    @Param("shipmentId", ParseIntPipe) shipmentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.findOne(u.orgId, u.userId, shipmentId);
  }

  @Post()
  @ResponseSchema(invShipmentSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:shipments:manage")
  @Idempotent("inventory.shipment.create")
  @Validate({ body: createShipmentSchema })
  create(
    @Body() body: CreateShipmentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.create(u.orgId, u.userId, body);
  }

  @Patch(":shipmentId")
  @ResponseSchema(invShipmentSchema)
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
  @ResponseSchema(invShipmentSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:shipments:manage")
  @HttpCode(HttpStatus.OK)
  @Validate({ params: shipmentIdParams, body: shipActionSchema })
  ship(
    @Param("shipmentId", ParseIntPipe) shipmentId: number,
    @Body() body: ShipActionInput,
    @IdempotencyKey() idempotencyKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.ship(u.orgId, u.userId, shipmentId, body, idempotencyKey);
  }

  @Post(":shipmentId/cancel")
  @BodylessAction()
  @ResponseSchema(invShipmentSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:shipments:manage")
  @Idempotent("inventory.shipment.cancel")
  @HttpCode(HttpStatus.OK)
  @Validate({ params: shipmentIdParams })
  cancel(
    @Param("shipmentId", ParseIntPipe) shipmentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.cancel(u.orgId, u.userId, shipmentId);
  }
}
