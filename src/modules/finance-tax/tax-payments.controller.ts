import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { TaxPaymentsService } from "./tax-payments.service";
import {
  createTaxPaymentSchema,
  listTaxPaymentsQuerySchema,
  type CreateTaxPaymentInput,
  type ListTaxPaymentsQuery,
} from "./dto/tax-payments.schemas";

@RequireModule("accounting")
@Controller("accounting/taxes/payments")
@UseGuards(JwtAuthGuard)
export class TaxPaymentsController {
  constructor(private readonly taxPayments: TaxPaymentsService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:taxes:read")
  list(
    @Query(new ZodValidationPipe(listTaxPaymentsQuerySchema)) query: ListTaxPaymentsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.taxPayments.list(u.orgId, query);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:taxes:pay")
  @HttpCode(201)
  @Idempotent("accounting.tax-payment.create")
  create(
    @Body(new ZodValidationPipe(createTaxPaymentSchema)) body: CreateTaxPaymentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.taxPayments.create(u, body);
  }

  @Delete(":paymentId")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:taxes:pay")
  @HttpCode(200)
  delete(
    @Param("paymentId", ParseIntPipe) paymentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.taxPayments.delete(u, paymentId);
  }
}
