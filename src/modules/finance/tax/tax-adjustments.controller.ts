import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { TaxAdjustmentsService } from "./tax-adjustments.service";
import { createTaxAdjustmentSchema, type CreateTaxAdjustmentInput } from "./dto/tax-adjustments.schemas";

@RequireModule("accounting")
@Controller("accounting/taxes/adjustments")
@UseGuards(JwtAuthGuard)
export class TaxAdjustmentsController {
  constructor(private readonly adjustments: TaxAdjustmentsService) {}

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:taxes:manage")
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createTaxAdjustmentSchema)) body: CreateTaxAdjustmentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.adjustments.createAdjustment(u, body);
  }
}
