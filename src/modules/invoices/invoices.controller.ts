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
import { AbilityGuard } from "../../common/rbac/ability.guard";
import { CheckAbility } from "../../common/rbac/check-ability.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { InvoicesService } from "./invoices.service";
import { listInvoicesSchema, type ListInvoicesInput } from "./dto/invoice.schemas";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

@Controller("invoices")
@UseGuards(JwtAuthGuard)
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get()
  @UseGuards(AbilityGuard)
  @CheckAbility("read", "accounting")
  list(
    @Query(new ZodValidationPipe(listInvoicesSchema)) filters: ListInvoicesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.invoices.list(u.orgId, filters);
  }

  @Get("stats")
  stats(@CurrentUser() u: CurrentUserContext) {
    return this.invoices.getStats(u.orgId);
  }

  @Get("recurring")
  listRecurring(@CurrentUser() u: CurrentUserContext) {
    return this.invoices.listRecurring(u.orgId, todayIso());
  }

  @Get(":invoiceId")
  async get(
    @Param("invoiceId", ParseIntPipe) invoiceId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const invoice = await this.invoices.getInvoice(u.orgId, invoiceId);
    if (!invoice) throw new NotFoundException("Invoice not found");
    return invoice;
  }

  @Get(":invoiceId/payments")
  listPayments(
    @Param("invoiceId", ParseIntPipe) invoiceId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.invoices.getInvoicePayments(u.orgId, invoiceId);
  }
}
