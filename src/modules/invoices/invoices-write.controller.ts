import {
  Body,
  Controller,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { InvoicesWriteService } from "./invoices-write.service";
import {
  createInvoiceSchema,
  recordPaymentSchema,
  updateInvoiceSchema,
  type CreateInvoiceInput,
  type RecordPaymentInput,
  type UpdateInvoiceInput,
} from "./dto/invoice-write.schemas";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

@Controller("invoices")
@UseGuards(JwtAuthGuard)
export class InvoicesWriteController {
  constructor(private readonly invoicesWrite: InvoicesWriteService) {}

  @Post()
  @HttpCode(201)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:create")
  async create(
    @Body(new ZodValidationPipe(createInvoiceSchema)) body: CreateInvoiceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const { invoice } = await this.invoicesWrite.createInvoice(u.orgId, u.userId, body);
    return invoice;
  }

  @Post("recurring/run")
  @HttpCode(200)
  runRecurring(@CurrentUser() u: CurrentUserContext) {
    return this.invoicesWrite.generateDueRecurringInvoices(u.orgId, u.userId, todayIso());
  }

  @Patch(":invoiceId")
  async updateInvoice(
    @Param("invoiceId", ParseIntPipe) invoiceId: number,
    @Body(new ZodValidationPipe(updateInvoiceSchema)) body: UpdateInvoiceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.invoicesWrite.updateInvoice(u.orgId, u.userId, invoiceId, body);
    return { success: true };
  }

  @Post(":invoiceId/payments")
  @HttpCode(201)
  recordPayment(
    @Param("invoiceId", ParseIntPipe) invoiceId: number,
    @Body(new ZodValidationPipe(recordPaymentSchema)) body: RecordPaymentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.invoicesWrite.recordPayment(u.orgId, u.userId, invoiceId, body);
  }
}
