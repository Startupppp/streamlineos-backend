import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { InvoicesService } from "./invoices.service";
import { listInvoicesSchema, type ListInvoicesInput } from "./dto/invoice.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import {
  invoiceListResponseSchema,
  invoiceStatsResponseSchema,
  recurringInvoiceListResponseSchema,
  invoiceDetailResponseSchema,
  invoicePaymentsListResponseSchema,
} from "./dto/invoice-response.schemas";

const invoiceIdParams = z.object({ invoiceId: z.coerce.number().int().positive() }).strict();

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

@RequireModule("accounting")
@Controller("invoices")
@UseGuards(JwtAuthGuard)
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get()
  @ResponseSchema(invoiceListResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:read")
  @Validate({ query: listInvoicesSchema })
  list(
    @Query() filters: ListInvoicesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.invoices.list(u.orgId, filters);
  }

  @Get("stats")
  @ResponseSchema(invoiceStatsResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:read")
  stats(@CurrentUser() u: CurrentUserContext) {
    return this.invoices.getStats(u.orgId);
  }

  @Get("recurring")
  @ResponseSchema(recurringInvoiceListResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:read")
  listRecurring(@CurrentUser() u: CurrentUserContext) {
    return this.invoices.listRecurring(u.orgId, todayIso());
  }

  @Get(":invoiceId")
  @ResponseSchema(invoiceDetailResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:read")
  @Validate({ params: invoiceIdParams })
  async get(
    @Param("invoiceId", ParseIntPipe) invoiceId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const invoice = await this.invoices.getInvoice(u.orgId, invoiceId);
    if (!invoice) throw new NotFoundException("Invoice not found");
    return invoice;
  }

  @Get(":invoiceId/payments")
  @ResponseSchema(invoicePaymentsListResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:read")
  @Validate({ params: invoiceIdParams })
  listPayments(
    @Param("invoiceId", ParseIntPipe) invoiceId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.invoices.getInvoicePayments(u.orgId, invoiceId);
  }
}
