import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { TaxAdjustmentsService } from "./tax-adjustments.service";
import { createTaxAdjustmentSchema, type CreateTaxAdjustmentInput } from "./dto/tax-adjustments.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { taxAdjustmentCreatedResponseSchema } from "./dto/tax-response.schemas";

@RequireModule("accounting")
@Controller("accounting/taxes/adjustments")
@UseGuards(JwtAuthGuard)
export class TaxAdjustmentsController {
  constructor(private readonly adjustments: TaxAdjustmentsService) {}

  @Post()
  @ResponseSchema(taxAdjustmentCreatedResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:taxes:manage")
  @HttpCode(201)
  @Validate({ body: createTaxAdjustmentSchema })
  create(
    @Body() body: CreateTaxAdjustmentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.adjustments.createAdjustment(u, body);
  }
}
