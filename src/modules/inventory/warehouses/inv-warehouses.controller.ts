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
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  listWarehousesResponseSchema,
  getWarehouseResponseSchema,
  invWarehouseSchema,
  listLocationsResponseSchema,
  invLocationSchema,
  getWarehouseStockResponseSchema,
  suggestPutawayResponseSchema,
  listWarehouseUsersResponseSchema,
  listAssignableUsersResponseSchema,
  grantWarehouseUserResponseSchema,
  revokeWarehouseUserResponseSchema,
} from "./dto/warehouses-response.schemas";

const warehouseIdParams = z.object({ warehouseId: z.coerce.number().int().positive() }).strict();
const warehouseIdlocationIdParams = z.object({ warehouseId: z.coerce.number().int().positive(), locationId: z.coerce.number().int().positive() }).strict();

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
  @ResponseSchema(suggestPutawayResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  suggestPutaway(
    @Query(new ZodValidationPipe(suggestPutawaySchema)) query: SuggestPutawayInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.putaway.suggest(u.orgId, u.userId, query);
  }

  /**
   * G8/T15. The paginated envelope — the frontend hook was requesting no
   * `page`/`limit` at all and had no `total` to page against.
   */
  @Get()
  @ResponseSchema(listWarehousesResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:warehouses:read")
  @Validate({ query: listWarehousesSchema })
  list(
    @Query() filters: ListWarehousesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.warehouses.listWarehousesPage(u.orgId, u.userId, filters);
  }

  @Get(":warehouseId")
  @ResponseSchema(getWarehouseResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:warehouses:read")
  @Validate({ params: warehouseIdParams })
  get(@Param("warehouseId", ParseIntPipe) warehouseId: number, @CurrentUser() u: CurrentUserContext) {
    return this.warehouses.getWarehouse(u.orgId, u.userId, warehouseId);
  }

  /**
   * A7. Who holds scope on this warehouse. Reading the assignment list is an
   * administrative act, so it sits on the same key as changing it.
   */
  @Get(":warehouseId/users")
  @ResponseSchema(listWarehouseUsersResponseSchema)
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
  @ResponseSchema(listAssignableUsersResponseSchema)
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
  @ResponseSchema(grantWarehouseUserResponseSchema)
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
  @ResponseSchema(revokeWarehouseUserResponseSchema)
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
  @ResponseSchema(invWarehouseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:warehouses:manage")
  @Idempotent("inventory.warehouse.create")
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
    return this.warehouses.updateWarehouse(u.orgId, u.userId, warehouseId, body);
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
    return this.warehouses.getWarehouseStock(u.orgId, u.userId, warehouseId, filters.page, filters.limit);
  }

  @Get(":warehouseId/locations")
  @ResponseSchema(listLocationsResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:warehouses:read")
  @Validate({ params: warehouseIdParams })
  listLocations(@Param("warehouseId", ParseIntPipe) warehouseId: number, @CurrentUser() u: CurrentUserContext) {
    return this.warehouses.listLocations(u.orgId, u.userId, warehouseId);
  }

  @Post(":warehouseId/locations")
  @ResponseSchema(invLocationSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:warehouses:manage")
  @Idempotent("inventory.warehouse.location.create")
  @Validate({ params: warehouseIdParams, body: createLocationSchema })
  createLocation(
    @Param("warehouseId", ParseIntPipe) warehouseId: number,
    @Body() body: CreateLocationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.warehouses.createLocation(u.orgId, u.userId, warehouseId, body);
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
    return this.warehouses.updateLocation(u.orgId, u.userId, locationId, body);
  }
}
