import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { TaxCodesService } from "./tax-codes.service";
import {
  createTaxCodeSchema,
  listTaxCodesQuerySchema,
  updateTaxCodeSchema,
  type CreateTaxCodeInput,
  type ListTaxCodesQuery,
  type UpdateTaxCodeInput,
} from "./dto/tax-codes.schemas";

@RequireModule("accounting")
@Controller("accounting/tax-codes")
@UseGuards(JwtAuthGuard)
export class TaxCodesController {
  constructor(private readonly taxCodes: TaxCodesService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:taxes:read")
  list(
    @Query(new ZodValidationPipe(listTaxCodesQuerySchema)) query: ListTaxCodesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.taxCodes.list(u.orgId, query);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:taxes:manage")
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createTaxCodeSchema)) body: CreateTaxCodeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.taxCodes.create(u.orgId, u.userId, body);
  }

  @Post("seed-defaults")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:taxes:manage")
  @HttpCode(200)
  seedDefaults(@CurrentUser() u: CurrentUserContext) {
    return this.taxCodes.seedDefaults(u.orgId, u.userId);
  }

  @Patch(":taxCodeId")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:taxes:manage")
  update(
    @Param("taxCodeId", ParseIntPipe) taxCodeId: number,
    @Body(new ZodValidationPipe(updateTaxCodeSchema)) body: UpdateTaxCodeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.taxCodes.update(u.orgId, taxCodeId, u.userId, body);
  }
}
