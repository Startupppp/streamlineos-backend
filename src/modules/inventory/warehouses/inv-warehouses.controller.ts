import { Controller, Get, Post, Patch, Body, Param, ParseIntPipe, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { InvWarehousesService } from "./inv-warehouses.service";
import { InvWarehouseLocationsService } from "./inv-warehouse-locations.service";
import {
  createWarehouseSchema, updateWarehouseSchema, createLocationSchema, updateLocationSchema, listWarehouseStockSchema, listWarehousesSchema,
  type CreateWarehouseInput, type UpdateWarehouseInput, type CreateLocationInput, type UpdateLocationInput, type ListWarehouseStockInput, type ListWarehousesInput,
} from "./dto/inv-warehouses.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  listWarehousesResponseSchema,
  getWarehouseResponseSchema,
  invWarehouseSchema,
  listLocationsResponseSchema,
  invLocationSchema,
  getWarehouseStockResponseSchema,
} from "./dto/warehouses-response.schemas";

const warehouseIdParams = z.object({ warehouseId: z.coerce.number().int().positive() }).strict();
const warehouseIdlocationIdParams = z.object({ warehouseId: z.coerce.number().int().positive(), locationId: z.coerce.number().int().positive() }).strict();

@RequireModule("inventory")
@Controller("inventory/warehouses")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvWarehousesController {
  constructor(
    private readonly warehouses: InvWarehousesService,
    private readonly locations: InvWarehouseLocationsService,
  ) {}

  @Get()
  @ResponseSchema(listWarehousesResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:warehouses:read")
  @Validate({ query: listWarehousesSchema })
  list(
    @Query() filters: ListWarehousesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.warehouses.listWarehouses(u.orgId, u.userId, filters);
  }

  @Get(":warehouseId")
  @ResponseSchema(getWarehouseResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:warehouses:read")
  @Validate({ params: warehouseIdParams })
  get(@Param("warehouseId", ParseIntPipe) warehouseId: number, @CurrentUser() u: CurrentUserContext) {
    return this.warehouses.getWarehouse(u.orgId, warehouseId);
  }

  @Post()
  @ResponseSchema(invWarehouseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:warehouses:manage")
  @Validate({ body: createWarehouseSchema })
  create(
    @Body() body: CreateWarehouseInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.warehouses.createWarehouse(u.orgId, u.userId, body);
  }

  @Patch(":warehouseId")
  @ResponseSchema(invWarehouseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:warehouses:manage")
  @Validate({ params: warehouseIdParams, body: updateWarehouseSchema })
  update(
    @Param("warehouseId", ParseIntPipe) warehouseId: number,
    @Body() body: UpdateWarehouseInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.warehouses.updateWarehouse(u.orgId, warehouseId, body);
  }

  @Get(":warehouseId/stock")
  @ResponseSchema(getWarehouseStockResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  @Validate({ params: warehouseIdParams, query: listWarehouseStockSchema })
  getStock(
    @Param("warehouseId", ParseIntPipe) warehouseId: number,
    @Query() filters: ListWarehouseStockInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.locations.getWarehouseStock(u.orgId, warehouseId, filters.page, filters.limit);
  }

  @Get(":warehouseId/locations")
  @ResponseSchema(listLocationsResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:warehouses:read")
  @Validate({ params: warehouseIdParams })
  listLocations(@Param("warehouseId", ParseIntPipe) warehouseId: number, @CurrentUser() u: CurrentUserContext) {
    return this.locations.listLocations(u.orgId, warehouseId);
  }

  @Post(":warehouseId/locations")
  @ResponseSchema(invLocationSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:warehouses:manage")
  @Validate({ params: warehouseIdParams, body: createLocationSchema })
  createLocation(
    @Param("warehouseId", ParseIntPipe) warehouseId: number,
    @Body() body: CreateLocationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.locations.createLocation(u.orgId, warehouseId, body);
  }

  @Patch(":warehouseId/locations/:locationId")
  @ResponseSchema(invLocationSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:warehouses:manage")
  @Validate({ params: warehouseIdlocationIdParams, body: updateLocationSchema })
  updateLocation(
    @Param("warehouseId", ParseIntPipe) _: number,
    @Param("locationId", ParseIntPipe) locationId: number,
    @Body() body: UpdateLocationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.locations.updateLocation(u.orgId, locationId, body);
  }
}
