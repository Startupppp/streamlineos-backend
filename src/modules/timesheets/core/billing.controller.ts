import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccessService } from "../../access/access.service";
import { BillingService } from "./billing.service";
import { resolveRatePreviewSubject } from "./timesheets-core-scope";
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
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  billingUninvoicedResponseSchema,
  billingExportResponseSchema,
  billingInvoiceDraftResponseSchema,
  billingRatePreviewResponseSchema,
} from "./dto/timesheets-response.schemas";

@RequireModule("timesheets")
@Controller("timesheets/billing")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class TimesheetBillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly access: AccessService,
  ) {}

  @Get("uninvoiced")
  @RequirePermission("timesheets:billing:view")
  @Validate({ query: uninvoicedQuerySchema })
  @ResponseSchema(billingUninvoicedResponseSchema)
  getUninvoiced(
    @Query() query: UninvoicedQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.billing.getUninvoiced(u, query);
  }

  @Post("export")
  @HttpCode(201)
  @RequirePermission("timesheets:billing:export")
  @Validate({ body: exportBillingSchema })
  @ResponseSchema(billingExportResponseSchema)
  export(
    @Body() body: ExportBillingInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.billing.exportBilling(u, body);
  }

  @Post("create-invoice-draft")
  @HttpCode(201)
  @RequirePermission("timesheets:billing:invoice")
  @Validate({ body: createInvoiceDraftSchema })
  @ResponseSchema(billingInvoiceDraftResponseSchema)
  createInvoiceDraft(
    @Body() body: CreateInvoiceDraftInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.billing.createInvoiceDraft(u, body);
  }

  @Get("rate-preview")
  @RequirePermission("timesheets:billing:view")
  @Validate({ query: ratePreviewQuerySchema })
  @ResponseSchema(billingRatePreviewResponseSchema)
  async ratePreview(
    @Query() query: RatePreviewQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const subjectUserId = await resolveRatePreviewSubject(this.access, u, query.userId);
    return await this.billing.getRatePreview(u, query, subjectUserId);
  }
}
