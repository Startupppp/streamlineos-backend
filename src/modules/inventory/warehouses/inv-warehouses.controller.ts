import { Controller, Get, Post, Patch, Delete, Body, Param, ParseIntPipe, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { InvWarehousesService } from "./inv-warehouses.service";
import { PutawayService } from "./putaway.service";
import { WarehouseAssignmentsService } from "./warehouse-assignments.service";
import {
  suggestPutawaySchema,
  type SuggestPutawayInput,
  createWarehouseSchema, updateWarehouseSchema, createLocationSchema, updateLocationSchema, listWarehouseStockSchema, listWarehousesSchema,
  type CreateWarehouseInput, type UpdateWarehouseInput, type CreateLocationInput, type UpdateLocationInput, type ListWarehouseStockInput, type ListWarehousesInput,
  grantWarehouseUserSchema, listAssignableUsersSchema, listWarehouseUsersSchema,
  type GrantWarehouseUserInput, type ListAssignableUsersInput, type ListWarehouseUsersInput,
} from "./dto/inv-warehouses.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";

@RequireModule("inventory")
@Controller("inventory/warehouses")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvWarehousesController {
  constructor(
    private readonly warehouses: InvWarehousesService,
    private readonly putaway: PutawayService,
    private readonly assignments: WarehouseAssignmentsService,
  ) {}

  /**
   * INV-202. Advisory: it says where the goods would fit, and the engine still
   * refuses a putaway that does not. A suggestion is not an authorisation.
   */
  @Get("putaway/suggestions")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  suggestPutaway(
    @Query(new ZodValidationPipe(suggestPutawaySchema)) query: SuggestPutawayInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.putaway.suggest(u.orgId, u.userId, query);
  }

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:warehouses:read")
  list(
    @Query(new ZodValidationPipe(listWarehousesSchema)) filters: ListWarehousesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.warehouses.listWarehouses(u.orgId, u.userId, filters);
  }

  @Get(":warehouseId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:warehouses:read")
  get(@Param("warehouseId", ParseIntPipe) warehouseId: number, @CurrentUser() u: CurrentUserContext) {
    return this.warehouses.getWarehouse(u.orgId, u.userId, warehouseId);
  }

  /**
   * A7. Who holds scope on this warehouse. Reading the assignment list is an
   * administrative act, so it sits on the same key as changing it.
   */
  @Get(":warehouseId/users")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:warehouses:manage")
  listAssignedUsers(
    @Param("warehouseId", ParseIntPipe) warehouseId: number,
    @Query(new ZodValidationPipe(listWarehouseUsersSchema)) filters: ListWarehouseUsersInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.assignments.listAssignedUsers(u.orgId, warehouseId, filters);
  }

  @Get(":warehouseId/assignable-users")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:warehouses:manage")
  listAssignableUsers(
    @Param("warehouseId", ParseIntPipe) warehouseId: number,
    @Query(new ZodValidationPipe(listAssignableUsersSchema)) filters: ListAssignableUsersInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.assignments.listAssignableUsers(u.orgId, warehouseId, filters);
  }

  @Post(":warehouseId/users")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:warehouses:manage")
  grantWarehouseUser(
    @Param("warehouseId", ParseIntPipe) warehouseId: number,
    @Body(new ZodValidationPipe(grantWarehouseUserSchema)) body: GrantWarehouseUserInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.assignments.grant(u.orgId, u.userId, warehouseId, body.userId);
  }

  @Delete(":warehouseId/users/:assigneeUserId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:warehouses:manage")
  revokeWarehouseUser(
    @Param("warehouseId", ParseIntPipe) warehouseId: number,
    @Param("assigneeUserId") assigneeUserId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.assignments.revoke(u.orgId, u.userId, warehouseId, assigneeUserId);
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

  @Get(":warehouseId/stock")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  getStock(
    @Param("warehouseId", ParseIntPipe) warehouseId: number,
    @Query(new ZodValidationPipe(listWarehouseStockSchema)) filters: ListWarehouseStockInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.warehouses.getWarehouseStock(u.orgId, u.userId, warehouseId, filters.page, filters.limit);
  }

  @Get(":warehouseId/locations")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:warehouses:read")
  listLocations(@Param("warehouseId", ParseIntPipe) warehouseId: number, @CurrentUser() u: CurrentUserContext) {
    return this.warehouses.listLocations(u.orgId, u.userId, warehouseId);
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
    @Param("warehouseId", ParseIntPipe) _: number,
    @Param("locationId", ParseIntPipe) locationId: number,
    @Body(new ZodValidationPipe(updateLocationSchema)) body: UpdateLocationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.warehouses.updateLocation(u.orgId, locationId, body);
  }
}
