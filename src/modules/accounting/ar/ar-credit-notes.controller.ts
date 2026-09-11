import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";
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
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { ArDocumentsService } from "./ar-documents.service";
import { ArDocumentPdfService } from "./ar-document-pdf.service";
import { ArReceiptsService } from "./ar-receipts.service";
import {
  createCreditNoteSchema,
  listArDocumentsSchema,
  updateDraftSchema,
  type CreateCreditNoteInput,
  type ListArDocumentsQuery,
  type UpdateDraftInput,
} from "./dto/ar-documents.schemas";
import {
  allocateCreditNoteSchema,
  type AllocateCreditNoteInput,
} from "./dto/ar-receipts.schemas";
import { ApiOkResponse } from "@nestjs/swagger";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  allocateCreditNoteResponseSchema,
  arTaxPreviewResponseSchema,
  createArDocumentResponseSchema,
  getArDocumentResponseSchema,
  listArDocumentsResponseSchema,
  postArDocumentResponseSchema,
  removeArDocumentResponseSchema,
  updateArDocumentResponseSchema,
} from "./dto/ar-response.schemas";

/**
 * Credit notes share `ar_documents` with invoices, so they share the service —
 * only the permission keys and the route differ.
 */
@RequireModule("accounting")
@Controller("accounting/ar/credit-notes")
@UseGuards(JwtAuthGuard)
export class ArCreditNotesController {
  constructor(
    private readonly documents: ArDocumentsService,
    private readonly receipts: ArReceiptsService,
    private readonly pdf: ArDocumentPdfService,
  ) {}

  @Get()
  @ResponseSchema(listArDocumentsResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:credit-notes:read")
  list(
    @Query(new ZodValidationPipe(listArDocumentsSchema)) query: ListArDocumentsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.documents.list(u.orgId, "CREDIT_NOTE", query);
  }

  @Post()
  @ResponseSchema(createArDocumentResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:credit-notes:create")
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createCreditNoteSchema)) body: CreateCreditNoteInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.documents.createCreditNote(u.orgId, u.userId, body);
  }

  @Get(":creditNoteId")
  @ResponseSchema(getArDocumentResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:credit-notes:read")
  get(@Param("creditNoteId") creditNoteId: string, @CurrentUser() u: CurrentUserContext) {
    return this.documents.get(u.orgId, creditNoteId);
  }

  @Get(":creditNoteId/tax-preview")
  @ResponseSchema(arTaxPreviewResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:credit-notes:read")
  previewTax(@Param("creditNoteId") creditNoteId: string, @CurrentUser() u: CurrentUserContext) {
    return this.documents.previewTax(u.orgId, creditNoteId);
  }

  /** Same layout as the invoice; the words and the signs differ. */
  @Get(":creditNoteId/pdf")
  @ApiOkResponse({
    description: "The rendered tax document as a PDF attachment.",
    content: { "application/pdf": { schema: { type: "string", format: "binary" } } },
  })
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:credit-notes:read")
  async pdfDocument(
    @Param("creditNoteId") creditNoteId: string,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ): Promise<void> {
    const rendered = await this.pdf.render(u.orgId, creditNoteId, "CREDIT_NOTE");
    res.setHeader("Content-Type", rendered.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${rendered.fileName}"`);
    res.setHeader("Content-Length", String(rendered.buffer.length));
    res.send(rendered.buffer);
  }

  @Patch(":creditNoteId")
  @ResponseSchema(updateArDocumentResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:credit-notes:manage")
  update(
    @Param("creditNoteId") creditNoteId: string,
    @Body(new ZodValidationPipe(updateDraftSchema)) body: UpdateDraftInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.documents.updateDraft(u.orgId, creditNoteId, body);
  }

  @Delete(":creditNoteId")
  @ResponseSchema(removeArDocumentResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:credit-notes:manage")
  remove(@Param("creditNoteId") creditNoteId: string, @CurrentUser() u: CurrentUserContext) {
    return this.documents.deleteDraft(u.orgId, creditNoteId);
  }

  @Post(":creditNoteId/post")
  @ResponseSchema(postArDocumentResponseSchema)
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:credit-notes:manage")
  @HttpCode(200)
  @Idempotent("accounting.ar.credit-note.post")
  post(@Param("creditNoteId") creditNoteId: string, @CurrentUser() u: CurrentUserContext) {
    return this.documents.post(u.orgId, u.userId, creditNoteId);
  }

  /** Offset the note against open invoices. No journal — both legs already hit AR. */
  @Post(":creditNoteId/allocations")
  @ResponseSchema(allocateCreditNoteResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:credit-notes:manage")
  @HttpCode(200)
  @Idempotent("accounting.ar.credit-note.allocate")
  allocate(
    @Param("creditNoteId") creditNoteId: string,
    @Body(new ZodValidationPipe(allocateCreditNoteSchema)) body: AllocateCreditNoteInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.receipts.allocateCreditNote(u.orgId, u.userId, creditNoteId, body);
  }
}
