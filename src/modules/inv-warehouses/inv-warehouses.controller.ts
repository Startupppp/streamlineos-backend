import { Controller, Get, Post, Patch, Body, Param, ParseIntPipe, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { AbilityGuard } from "../../common/rbac/ability.guard";
import { CheckAbility } from "../../common/rbac/check-ability.decorator";
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
  @UseGuards(AbilityGuard)
  @CheckAbility("read", "inventory:warehouses")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.warehouses.listWarehouses(u.orgId);
  }

  @Get(":warehouseId")
  @UseGuards(AbilityGuard)
  @CheckAbility("read", "inventory:warehouses")
  get(@Param("warehouseId", ParseIntPipe) warehouseId: number, @CurrentUser() u: CurrentUserContext) {
    return this.warehouses.getWarehouse(u.orgId, warehouseId);
  }

  @Post()
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "inventory:warehouses")
  create(
    @Body(new ZodValidationPipe(createWarehouseSchema)) body: CreateWarehouseInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.warehouses.createWarehouse(u.orgId, u.userId, body);
  }

  @Patch(":warehouseId")
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "inventory:warehouses")
  update(
    @Param("warehouseId", ParseIntPipe) warehouseId: number,
    @Body(new ZodValidationPipe(updateWarehouseSchema)) body: UpdateWarehouseInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.warehouses.updateWarehouse(u.orgId, warehouseId, body);
  }

  @Get(":warehouseId/locations")
  @UseGuards(AbilityGuard)
  @CheckAbility("read", "inventory:warehouses")
  listLocations(@Param("warehouseId", ParseIntPipe) warehouseId: number, @CurrentUser() u: CurrentUserContext) {
    return this.warehouses.listLocations(u.orgId, warehouseId);
  }

  @Post(":warehouseId/locations")
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "inventory:warehouses")
  createLocation(
    @Param("warehouseId", ParseIntPipe) warehouseId: number,
    @Body(new ZodValidationPipe(createLocationSchema)) body: CreateLocationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.warehouses.createLocation(u.orgId, warehouseId, body);
  }

  @Patch(":warehouseId/locations/:locationId")
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "inventory:warehouses")
  updateLocation(
    @Param("warehouseId", ParseIntPipe) _warehouseId: number,
    @Param("locationId", ParseIntPipe) locationId: number,
    @Body(new ZodValidationPipe(updateLocationSchema)) body: UpdateLocationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.warehouses.updateLocation(u.orgId, locationId, body);
  }
}
