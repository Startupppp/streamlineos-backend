import { Controller, Get, Post, Patch, Body, Param, ParseIntPipe, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { InvWarehousesService } from "./inv-warehouses.service";
import {
  createWarehouseSchema, updateWarehouseSchema, createLocationSchema, updateLocationSchema,
  type CreateWarehouseInput, type UpdateWarehouseInput, type CreateLocationInput, type UpdateLocationInput,
} from "./dto/inv-warehouses.schemas";

@Controller("inventory/warehouses")
@UseGuards(JwtAuthGuard)
export class InvWarehousesController {
  constructor(private readonly warehouses: InvWarehousesService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:warehouses:read")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.warehouses.listWarehouses(u.orgId);
  }

  @Get(":warehouseId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:warehouses:read")
  get(@Param("warehouseId", ParseIntPipe) warehouseId: number, @CurrentUser() u: CurrentUserContext) {
    return this.warehouses.getWarehouse(u.orgId, warehouseId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:warehouses:manage")
  create(
    @Body(new ZodValidationPipe(createWarehouseSchema)) body: CreateWarehouseInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.warehouses.createWarehouse(u.orgId, u.userId, body);
  }

  @Patch(":warehouseId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:warehouses:manage")
  update(
    @Param("warehouseId", ParseIntPipe) warehouseId: number,
    @Body(new ZodValidationPipe(updateWarehouseSchema)) body: UpdateWarehouseInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.warehouses.updateWarehouse(u.orgId, warehouseId, body);
  }

  @Get(":warehouseId/locations")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:warehouses:read")
  listLocations(@Param("warehouseId", ParseIntPipe) warehouseId: number, @CurrentUser() u: CurrentUserContext) {
    return this.warehouses.listLocations(u.orgId, warehouseId);
  }

  @Post(":warehouseId/locations")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:warehouses:manage")
  createLocation(
    @Param("warehouseId", ParseIntPipe) warehouseId: number,
    @Body(new ZodValidationPipe(createLocationSchema)) body: CreateLocationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.warehouses.createLocation(u.orgId, warehouseId, body);
  }

  @Patch(":warehouseId/locations/:locationId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:warehouses:manage")
  updateLocation(
    @Param("warehouseId", ParseIntPipe) _warehouseId: number,
    @Param("locationId", ParseIntPipe) locationId: number,
    @Body(new ZodValidationPipe(updateLocationSchema)) body: UpdateLocationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.warehouses.updateLocation(u.orgId, locationId, body);
  }
}
