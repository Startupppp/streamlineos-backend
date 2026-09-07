import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { TaxCodesService } from "./tax-codes.service";
import {
  createTaxCodeSchema,
  listTaxCodesQuerySchema,
  updateTaxCodeSchema,
  type CreateTaxCodeInput,
  type ListTaxCodesQuery,
  type UpdateTaxCodeInput,
} from "./dto/tax-codes.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { taxCodeListResponseSchema, taxCodeSchema, taxCodeSeedResponseSchema } from "./dto/tax-response.schemas";

const taxCodeIdParams = z.object({ taxCodeId: z.coerce.number().int().positive() }).strict();

@RequireModule("accounting")
@Controller("accounting/tax-codes")
@UseGuards(JwtAuthGuard)
export class TaxCodesController {
  constructor(private readonly taxCodes: TaxCodesService) {}

  @Get()
  @ResponseSchema(taxCodeListResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:taxes:read")
  @Validate({ query: listTaxCodesQuerySchema })
  list(
    @Query() query: ListTaxCodesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.taxCodes.list(u.orgId, query);
  }

  @Post()
  @ResponseSchema(taxCodeSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:taxes:manage")
  @HttpCode(201)
  @Validate({ body: createTaxCodeSchema })
  create(
    @Body() body: CreateTaxCodeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.taxCodes.create(u.orgId, u.userId, body);
  }

  @Post("seed-defaults")
  @ResponseSchema(taxCodeSeedResponseSchema)
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:taxes:manage")
  @HttpCode(200)
  seedDefaults(@CurrentUser() u: CurrentUserContext) {
    return this.taxCodes.seedDefaults(u.orgId, u.userId);
  }

  @Patch(":taxCodeId")
  @ResponseSchema(taxCodeSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:taxes:manage")
  @Validate({ params: taxCodeIdParams, body: updateTaxCodeSchema })
  update(
    @Param("taxCodeId", ParseIntPipe) taxCodeId: number,
    @Body() body: UpdateTaxCodeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.taxCodes.update(u.orgId, taxCodeId, u.userId, body);
  }
}
