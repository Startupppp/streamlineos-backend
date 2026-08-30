import { Controller, Get, Post, Patch, Body, Param, ParseIntPipe, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { InvVendorsService } from "./inv-vendors.service";
import {
  listVendorsSchema, createVendorSchema, updateVendorSchema,
  type ListVendorsInput, type CreateVendorInput, type UpdateVendorInput,
} from "./dto/inv-vendors.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const vendorIdParams = z.object({ vendorId: z.coerce.number().int().positive() }).strict();

@RequireModule("inventory")
@Controller("inventory/vendors")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvVendorsController {
  constructor(private readonly vendors: InvVendorsService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:vendors:read")
  @Validate({ query: listVendorsSchema })
  list(
    @Query() filters: ListVendorsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.vendors.listVendors(u.orgId, filters);
  }

  @Get(":vendorId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:vendors:read")
  @Validate({ params: vendorIdParams })
  get(
    @Param("vendorId", ParseIntPipe) vendorId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.vendors.getVendor(u.orgId, vendorId);
  }

  @Get(":vendorId/performance")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:vendors:read")
  @Validate({ params: vendorIdParams })
  getPerformance(
    @Param("vendorId", ParseIntPipe) vendorId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.vendors.getVendorPerformance(u.orgId, vendorId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:vendors:manage")
  @Validate({ body: createVendorSchema })
  create(
    @Body() body: CreateVendorInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.vendors.createVendor(u.orgId, u.userId, body);
  }

  @Patch(":vendorId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:vendors:manage")
  @Validate({ params: vendorIdParams, body: updateVendorSchema })
  update(
    @Param("vendorId", ParseIntPipe) vendorId: number,
    @Body() body: UpdateVendorInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.vendors.updateVendor(u.orgId, vendorId, body);
  }
}
