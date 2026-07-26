import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { BillingService } from "./billing.service";
import {
  uninvoicedQuerySchema,
  exportBillingSchema,
  createInvoiceDraftSchema,
  ratePreviewQuerySchema,
  type UninvoicedQuery,
  type ExportBillingInput,
  type CreateInvoiceDraftInput,
  type RatePreviewQuery,
} from "./dto/billing.schemas";

@RequireModule("projects")
@Controller("timesheets/billing")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get("uninvoiced")
  @RequirePermission("timesheets:billing:view")
  getUninvoiced(
    @Query(new ZodValidationPipe(uninvoicedQuerySchema)) query: UninvoicedQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.billing.getUninvoiced(u, query);
  }

  @Post("export")
  @HttpCode(201)
  @RequirePermission("timesheets:billing:export")
  export(
    @Body(new ZodValidationPipe(exportBillingSchema)) body: ExportBillingInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.billing.exportBilling(u, body);
  }

  @Post("create-invoice-draft")
  @HttpCode(201)
  @RequirePermission("timesheets:billing:invoice")
  createInvoiceDraft(
    @Body(new ZodValidationPipe(createInvoiceDraftSchema)) body: CreateInvoiceDraftInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.billing.createInvoiceDraft(u, body);
  }

  @Get("rate-preview")
  @RequirePermission("timesheets:billing:view")
  ratePreview(
    @Query(new ZodValidationPipe(ratePreviewQuerySchema)) query: RatePreviewQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.billing.getRatePreview(u, query);
  }
}
