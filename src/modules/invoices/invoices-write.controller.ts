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
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { InvoicesWriteService } from "./invoices-write.service";
import {
  createInvoiceSchema,
  recordPaymentSchema,
  updateInvoiceSchema,
  type CreateInvoiceInput,
  type RecordPaymentInput,
  type UpdateInvoiceInput,
} from "./dto/invoice-write.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { z } from "zod";
import { Validate } from "../../common/validation/validate.decorator";
import { BodylessAction } from "../../common/openapi/zod-operation-contracts";

const invoiceIdParams = z.object({ invoiceId: z.coerce.number().int().positive() }).strict();

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

@RequireModule("accounting")
@Controller("invoices")
@UseGuards(JwtAuthGuard)
export class InvoicesWriteController {
  constructor(private readonly invoicesWrite: InvoicesWriteService) {}

  @Post()
  @HttpCode(201)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:create")
  @Idempotent("accounting.invoice.create")
  @Validate({ body: createInvoiceSchema })
  async create(
    @Body() body: CreateInvoiceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const { invoice } = await this.invoicesWrite.createInvoice(u.orgId, u.userId, body);
    return invoice;
  }

  @Post("recurring/run")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:manage")
  @BodylessAction()
  runRecurring(@CurrentUser() u: CurrentUserContext) {
    return this.invoicesWrite.generateDueRecurringInvoices(u.orgId, u.userId, todayIso());
  }

  @Patch(":invoiceId")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:update")
  @Idempotent("accounting.invoice.update")
  @Validate({ params: invoiceIdParams, body: updateInvoiceSchema })
  async updateInvoice(
    @Param("invoiceId", ParseIntPipe) invoiceId: number,
    @Body() body: UpdateInvoiceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.invoicesWrite.updateInvoice(u.orgId, u.userId, invoiceId, body);
    return { success: true };
  }

  @Post(":invoiceId/payments")
  @HttpCode(201)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:create")
  @Idempotent("accounting.invoice.payment.record")
  @Validate({ params: invoiceIdParams, body: recordPaymentSchema })
  recordPayment(
    @Param("invoiceId", ParseIntPipe) invoiceId: number,
    @Body() body: RecordPaymentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.invoicesWrite.recordPayment(u.orgId, u.userId, invoiceId, body);
  }

  @Post(":invoiceId/void")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:manage")
  @Idempotent("accounting.invoice.void")
  @Validate({ params: invoiceIdParams })
  @BodylessAction()
  voidInvoice(
    @Param("invoiceId", ParseIntPipe) invoiceId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.invoicesWrite.voidInvoice(u.orgId, u.userId, invoiceId);
  }
}
