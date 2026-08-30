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
import { z } from "zod";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { Validate } from "../../common/validation/validate.decorator";
import { InvoicesService } from "./invoices.service";
import { listInvoicesSchema, type ListInvoicesInput } from "./dto/invoice.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";

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
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:read")
  list(
    @Query(new ZodValidationPipe(listInvoicesSchema)) filters: ListInvoicesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.invoices.list(u.orgId, filters);
  }

  @Get("stats")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:read")
  stats(@CurrentUser() u: CurrentUserContext) {
    return this.invoices.getStats(u.orgId);
  }

  @Get("recurring")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:read")
  listRecurring(@CurrentUser() u: CurrentUserContext) {
    return this.invoices.listRecurring(u.orgId, todayIso());
  }

  @Get(":invoiceId")
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
