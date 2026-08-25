import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { ArDocumentsService } from "./ar-documents.service";
import {
  createInvoiceSchema,
  creditNoteFromInvoiceSchema,
  listArDocumentsSchema,
  updateDraftSchema,
  type CreateInvoiceInput,
  type CreditNoteFromInvoiceInput,
  type ListArDocumentsQuery,
  type UpdateDraftInput,
} from "./dto/ar-documents.schemas";

@RequireModule("accounting")
@Controller("accounting/ar/invoices")
@UseGuards(JwtAuthGuard)
export class ArInvoicesController {
  constructor(private readonly documents: ArDocumentsService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:receivables:read")
  list(
    @Query(new ZodValidationPipe(listArDocumentsSchema)) query: ListArDocumentsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.documents.list(u.orgId, "INVOICE", query);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:receivables:manage")
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createInvoiceSchema)) body: CreateInvoiceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.documents.createInvoice(u.orgId, u.userId, body);
  }

  @Get(":invoiceId")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:receivables:read")
  get(@Param("invoiceId") invoiceId: string, @CurrentUser() u: CurrentUserContext) {
    return this.documents.get(u.orgId, invoiceId);
  }

  /** Determination without persistence — no journal, no number, no frozen rows. */
  @Get(":invoiceId/tax-preview")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:receivables:read")
  previewTax(@Param("invoiceId") invoiceId: string, @CurrentUser() u: CurrentUserContext) {
    return this.documents.previewTax(u.orgId, invoiceId);
  }

  /** The engine's frozen verdict on a posted invoice, as the return will read it. */
  @Get(":invoiceId/tax-lines")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:taxes:read")
  taxLines(@Param("invoiceId") invoiceId: string, @CurrentUser() u: CurrentUserContext) {
    return this.documents.frozenTaxLines(u.orgId, invoiceId);
  }

  @Patch(":invoiceId")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:receivables:manage")
  update(
    @Param("invoiceId") invoiceId: string,
    @Body(new ZodValidationPipe(updateDraftSchema)) body: UpdateDraftInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.documents.updateDraft(u.orgId, invoiceId, body);
  }

  @Delete(":invoiceId")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:receivables:manage")
  remove(@Param("invoiceId") invoiceId: string, @CurrentUser() u: CurrentUserContext) {
    return this.documents.deleteDraft(u.orgId, invoiceId);
  }

  /**
   * Post the invoice. Safe to double-click: the second call returns the first
   * call's journal rather than posting a second one.
   */
  @Post(":invoiceId/post")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:receivables:manage")
  @HttpCode(200)
  @Idempotent("accounting.ar.invoice.post")
  post(@Param("invoiceId") invoiceId: string, @CurrentUser() u: CurrentUserContext) {
    return this.documents.post(u.orgId, u.userId, invoiceId);
  }

  /** A posted invoice is corrected by a credit note, never by an edit. */
  @Post(":invoiceId/credit-note")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:credit-notes:create")
  @HttpCode(201)
  creditNote(
    @Param("invoiceId") invoiceId: string,
    @Body(new ZodValidationPipe(creditNoteFromInvoiceSchema)) body: CreditNoteFromInvoiceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.documents.creditNoteFromInvoice(u.orgId, u.userId, invoiceId, body);
  }
}
