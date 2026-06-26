import { Controller, Get, Post, Patch, Body, Param, ParseIntPipe, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { AbilityGuard } from "../../common/rbac/ability.guard";
import { CheckAbility } from "../../common/rbac/check-ability.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { InvVendorsService } from "./inv-vendors.service";
import {
  listVendorsSchema, createVendorSchema, updateVendorSchema,
  type ListVendorsInput, type CreateVendorInput, type UpdateVendorInput,
} from "./dto/inv-vendors.schemas";

@Controller("inventory/vendors")
@UseGuards(JwtAuthGuard)
export class InvVendorsController {
  constructor(private readonly vendors: InvVendorsService) {}

  @Get()
  @UseGuards(AbilityGuard)
  @CheckAbility("read", "inventory:vendors")
  list(
    @Query(new ZodValidationPipe(listVendorsSchema)) filters: ListVendorsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.vendors.listVendors(u.orgId, filters);
  }

  @Get(":vendorId")
  @UseGuards(AbilityGuard)
  @CheckAbility("read", "inventory:vendors")
  get(
    @Param("vendorId", ParseIntPipe) vendorId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.vendors.getVendor(u.orgId, vendorId);
  }

  @Post()
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "inventory:vendors")
  create(
    @Body(new ZodValidationPipe(createVendorSchema)) body: CreateVendorInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.vendors.createVendor(u.orgId, u.userId, body);
  }

  @Patch(":vendorId")
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "inventory:vendors")
  update(
    @Param("vendorId", ParseIntPipe) vendorId: number,
    @Body(new ZodValidationPipe(updateVendorSchema)) body: UpdateVendorInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.vendors.updateVendor(u.orgId, vendorId, body);
  }
}
