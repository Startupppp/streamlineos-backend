import { Controller, Get, Post, Patch, Body, Param, ParseIntPipe, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { InvVendorsService } from "./inv-vendors.service";
import { VendorScorecardService } from "./vendor-scorecard.service";
import {
  listVendorsSchema, createVendorSchema, updateVendorSchema, vendorDeliveriesSchema,
  type ListVendorsInput, type CreateVendorInput, type UpdateVendorInput,
  type VendorDeliveriesInput,
} from "./dto/inv-vendors.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const vendorIdParams = z.object({ vendorId: z.coerce.number().int().positive() }).strict();

@RequireModule("inventory")
@Controller("inventory/vendors")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvVendorsController {
  constructor(
    private readonly vendors: InvVendorsService,
    private readonly scorecard: VendorScorecardService,
  ) {}

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

  /**
   * C4. Lead time, fill rate, on-time and returns, every one of them beside the
   * sample it rests on, from the scorecard service rather than arithmetic done
   * here. Nothing in this controller computes anything.
   */
  @Get(":vendorId/performance")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:vendors:read")
  @Validate({ params: vendorIdParams })
  getPerformance(
    @Param("vendorId", ParseIntPipe) vendorId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.scorecard.scorecard(u.orgId, vendorId);
  }

  /** C4. The purchase orders and receipts every rate above was computed from. */
  @Get(":vendorId/deliveries")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:vendors:read")
  getDeliveries(
    @Param("vendorId", ParseIntPipe) vendorId: number,
    @Query(new ZodValidationPipe(vendorDeliveriesSchema)) filters: VendorDeliveriesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.scorecard.deliveries(u.orgId, vendorId, filters);
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
