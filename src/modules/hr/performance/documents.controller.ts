import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";

import { AccessService } from "../../access/access.service";
import {
  resolveDocumentsManageScope,
  resolveDocumentsScope,
} from "./performance-scope";
import { DocumentsService } from "./documents.service";
import { ComplianceService } from "./compliance.service";
import { RichDocumentsService } from "./rich-documents.service";
import { LettersService } from "./letters.service";
import {
  ackSchema,
  complianceCalendarQuerySchema,
  createDocumentSchema,
  createRichDocumentSchema,
  documentExpiryQuerySchema,
  listDocumentsSchema,
  listRichDocumentsSchema,
  renderLetterSchema,
  saveLetterSchema,
  sendAckSchema,
  updateDocumentSchema,
  updateRichDocumentSchema,
  type AckInput,
  type ComplianceCalendarQueryInput,
  type CreateDocumentInput,
  type CreateRichDocumentInput,
  type DocumentExpiryQueryInput,
  type ListDocumentsInput,
  type ListRichDocumentsInput,
  type RenderLetterInput,
  type SaveLetterInput,
  type SendAckInput,
  type UpdateDocumentInput,
  type UpdateRichDocumentInput,
} from "./dto/documents.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { AuditService } from "../../../common/audit/audit.service";
import { StorageService } from "../../storage/storage.service";
import { parseStorageKey } from "../../storage/storage-key";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction, ResponseSchema, NoContentResponse } from "../../../common/openapi/zod-operation-contracts";
import { listDocumentsResponseSchema, createDocumentResponseSchema, getDocumentFileResponseSchema, documentStatsResponseSchema, updateDocumentResponseSchema, documentExpiryResponseSchema, listComplianceResponseSchema, sendComplianceResponseSchema, acknowledgeComplianceResponseSchema, statutoryResponseSchema, listRichDocumentsResponseSchema, createRichDocumentResponseSchema, getRichDocumentResponseSchema, publishRichDocumentResponseSchema, updateRichDocumentResponseSchema, listLettersResponseSchema, renderLetterResponseSchema, saveLetterResponseSchema, complianceCalendarResponseSchema } from "./dto/documents-response.schemas"

const documentIdParams = z.object({ documentId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class DocumentsController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly compliance: ComplianceService,
    private readonly richDocuments: RichDocumentsService,
    private readonly letters: LettersService,
    private readonly access: AccessService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  // Rich documents and letters have no owner column, so there is nothing to narrow them by below `all`. They used to answer any holder of the key with the whole organisation's rows, personal letters included.
  private async requireOrgWideView(currentUser: CurrentUserContext): Promise<void> {
    const scope = await resolveDocumentsScope(this.access, currentUser);
    if (!scope.unrestricted) throw new ForbiddenException("Organization-wide document access is required.");
  }

  private async requireOrgWideManage(currentUser: CurrentUserContext): Promise<void> {
    const scope = await resolveDocumentsManageScope(this.access, currentUser);
    if (!scope.unrestricted) throw new ForbiddenException("Organization-wide document access is required.");
  }

  @ResponseSchema(listDocumentsResponseSchema)
  @Get("documents")
  @RequirePermission("hr:documents:view")
  @Validate({ query: listDocumentsSchema })
  async listDocuments(
    @Query() filters: ListDocumentsInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    const scope = await resolveDocumentsScope(this.access, currentUser);
    return this.documents.listDocuments(scope, filters, actingMembershipId(currentUser.principal));
  }

  @ResponseSchema(createDocumentResponseSchema)
  @Post("documents")
  @HttpCode(201)
  @RequirePermission("hr:documents:manage")
  @Validate({ body: createDocumentSchema })
  async createDocument(
    @Body() body: CreateDocumentInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    const scope = await resolveDocumentsManageScope(this.access, currentUser);
    return this.documents.createDocument(scope, body, actingMembershipId(currentUser.principal));
  }

  @ResponseSchema(getDocumentFileResponseSchema)
  @Get("documents/:documentId/file")
  @RequirePermission("hr:documents:view")
  @Validate({ params: documentIdParams })
  async getDocumentFile(
    @Param("documentId", ParseIntPipe) documentId: number,
    @CurrentUser() currentUser: CurrentUserContext,
  ): Promise<{ url: string; fileName: string; expiresIn: number }> {
    const scope = await resolveDocumentsScope(this.access, currentUser);
    const document = await this.documents.getFileReference(
      scope,
      documentId,
      actingMembershipId(currentUser.principal),
    );
    const fileKey = this.storage.getFileKeyFromUrl(document.fileUrl);
    if (!this.storage.isValidFileKey(fileKey)) {
      throw new NotFoundException("Document file is unavailable.");
    }
    const { folderRoot } = parseStorageKey(fileKey, currentUser.orgId);
    if (folderRoot !== "documents" && folderRoot !== "hr-documents" && folderRoot !== "hr") {
      throw new NotFoundException("Document file is unavailable.");
    }

    const expiresIn = 300;
    const url = await this.storage.getFileUrl(currentUser.orgId, fileKey, expiresIn, undefined, {
      preauthorized: true,
    });
    // V-148: every view was audited, but the row did not say WHOSE document it was, so the one view worth
    // looking at later - an administrator opening an employee's personal file - read exactly like an employee
    // opening their own. The predicate is recorded, not the decision: both views are allowed.
    const actorIsOwner = document.ownerUserId !== null && document.ownerUserId === currentUser.userId;
    await this.audit.logCriticalOutsideTransaction({
      action: "hr.document_viewed",
      userId: currentUser.userId,
      orgId: currentUser.orgId,
      targetId: String(document.documentId),
      targetType: "document",
      metadata: {
        fileName: document.fileName,
        actorIsOwner,
        documentIsOwned: document.ownerUserId !== null,
        classification: document.classification,
      },
    });
    return { url, fileName: document.fileName, expiresIn };
  }

  @ResponseSchema(documentStatsResponseSchema)
  @Get("documents/stats")
  @RequirePermission("hr:documents:view")
  async documentStats(@CurrentUser() currentUser: CurrentUserContext) {
    const scope = await resolveDocumentsScope(this.access, currentUser);
    return this.documents.stats(scope, actingMembershipId(currentUser.principal));
  }

  @ResponseSchema(updateDocumentResponseSchema)
  @Patch("documents/:documentId")
  @RequirePermission("hr:documents:manage")
  @Validate({ params: documentIdParams, body: updateDocumentSchema })
  async updateDocument(
    @Param("documentId", ParseIntPipe) documentId: number,
    @Body() body: UpdateDocumentInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    const scope = await resolveDocumentsManageScope(this.access, currentUser);
    return this.documents.updateDocument(
      scope,
      documentId,
      body,
      actingMembershipId(currentUser.principal),
    );
  }

  @NoContentResponse()
  @Delete("documents/:documentId")
  @HttpCode(204)
  @RequirePermission("hr:documents:manage")
  @Validate({ params: documentIdParams })
  async deleteDocument(
    @Param("documentId", ParseIntPipe) documentId: number,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    const scope = await resolveDocumentsManageScope(this.access, currentUser);
    await this.documents.deleteDocument(scope, documentId, actingMembershipId(currentUser.principal));
  }

  @ResponseSchema(documentExpiryResponseSchema)
  @Get("document-expiry")
  @RequirePermission("hr:documents:view")
  @Validate({ query: documentExpiryQuerySchema })
  async documentExpiry(
    @Query() query: DocumentExpiryQueryInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    const daysAhead = Math.min(Math.max(query.days ?? 30, 1), 365);
    const scope = await resolveDocumentsScope(this.access, currentUser);
    return this.documents.expiry(scope, daysAhead, actingMembershipId(currentUser.principal));
  }

  @ResponseSchema(listComplianceResponseSchema)
  @Get("compliance")
  @RequirePermission("hr:documents:view")
  async listCompliance(@CurrentUser() currentUser: CurrentUserContext) {
    const scope = await resolveDocumentsScope(this.access, currentUser);
    return this.compliance.listAcknowledgments(scope);
  }

  @ResponseSchema(sendComplianceResponseSchema)
  @Post("compliance")
  @HttpCode(201)
  @RequirePermission("hr:compliance:manage")
  @Validate({ body: sendAckSchema })
  sendCompliance(
    @Body() body: SendAckInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.compliance.sendAcknowledgments(currentUser.orgId, body);
  }

  @ResponseSchema(acknowledgeComplianceResponseSchema)
  @Patch("compliance")
  @RequirePermission("hr:documents:view")
  @Validate({ body: ackSchema })
  acknowledgeCompliance(
    @Body() body: AckInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.compliance.acknowledge(currentUser.orgId, currentUser.userId, body);
  }

  @ResponseSchema(statutoryResponseSchema)
  @Get("compliance/statutory")
  @RequirePermission("hr:compliance:manage")
  statutory(@CurrentUser() currentUser: CurrentUserContext) {
    return this.compliance.statutory(currentUser.orgId);
  }

  @ResponseSchema(listRichDocumentsResponseSchema)
  @Get("rich-documents")
  @RequirePermission("hr:documents:view")
  @Validate({ query: listRichDocumentsSchema })
  async listRichDocuments(
    @Query() query: ListRichDocumentsInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    await this.requireOrgWideView(currentUser);
    return this.richDocuments.list(currentUser.orgId, query);
  }

  @ResponseSchema(createRichDocumentResponseSchema)
  @Post("rich-documents")
  @HttpCode(201)
  @RequirePermission("hr:documents:manage")
  @Validate({ body: createRichDocumentSchema })
  async createRichDocument(
    @Body() body: CreateRichDocumentInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    await this.requireOrgWideManage(currentUser);
    return this.richDocuments.create(currentUser.orgId, currentUser.userId, body);
  }

  @ResponseSchema(getRichDocumentResponseSchema)
  @Get("rich-documents/:documentId")
  @RequirePermission("hr:documents:view")
  @Validate({ params: documentIdParams })
  async getRichDocument(
    @Param("documentId", ParseIntPipe) documentId: number,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    await this.requireOrgWideView(currentUser);
    return this.richDocuments.get(currentUser.orgId, documentId);
  }

  @ResponseSchema(publishRichDocumentResponseSchema)
  @Patch("rich-documents/:documentId/publish")
  @BodylessAction()
  @Idempotent("hr.performance-document.publish")
  @RequirePermission("hr:documents:manage")
  @Validate({ params: documentIdParams })
  async publishRichDocument(
    @Param("documentId", ParseIntPipe) documentId: number,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    await this.requireOrgWideManage(currentUser);
    return this.richDocuments.togglePublish(currentUser.orgId, documentId);
  }

  @ResponseSchema(updateRichDocumentResponseSchema)
  @Patch("rich-documents/:documentId")
  @RequirePermission("hr:documents:manage")
  @Validate({ params: documentIdParams, body: updateRichDocumentSchema })
  async updateRichDocument(
    @Param("documentId", ParseIntPipe) documentId: number,
    @Body() body: UpdateRichDocumentInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    await this.requireOrgWideManage(currentUser);
    return this.richDocuments.update(currentUser.orgId, currentUser.userId, documentId, body);
  }

  @NoContentResponse()
  @Delete("rich-documents/:documentId")
  @HttpCode(204)
  @RequirePermission("hr:documents:manage")
  @Validate({ params: documentIdParams })
  async deleteRichDocument(
    @Param("documentId", ParseIntPipe) documentId: number,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    await this.requireOrgWideManage(currentUser);
    await this.richDocuments.remove(currentUser.orgId, documentId);
  }

  @ResponseSchema(listLettersResponseSchema)
  @Get("documents/letters")
  @RequirePermission("hr:documents:view")
  async listLetters(
    @Query("employmentId") employmentId: string | undefined,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    await this.requireOrgWideView(currentUser);
    return this.letters.listLetters(currentUser.orgId, employmentId);
  }

  @ResponseSchema(renderLetterResponseSchema)
  @Post("documents/letters/render")
  @RequirePermission("hr:documents:manage")
  @HttpCode(200)
  @Validate({ body: renderLetterSchema })
  async renderLetter(
    @Body() body: RenderLetterInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    await this.requireOrgWideManage(currentUser);
    return this.letters.renderLetter(currentUser.orgId, body);
  }

  @ResponseSchema(saveLetterResponseSchema)
  @Post("documents/letters")
  @RequirePermission("hr:documents:manage")
  @HttpCode(201)
  @Validate({ body: saveLetterSchema })
  async saveLetter(
    @Body() body: SaveLetterInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    await this.requireOrgWideManage(currentUser);
    return this.letters.saveLetter(currentUser.orgId, currentUser.userId, body);
  }

  @ResponseSchema(complianceCalendarResponseSchema)
  @Get("compliance/calendar")
  @RequirePermission("hr:compliance:manage")
  @Validate({ query: complianceCalendarQuerySchema })
  complianceCalendar(
    @Query() query: ComplianceCalendarQueryInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    const now = new Date();
    const y = query.year ?? now.getFullYear();
    const m = query.month ?? now.getMonth() + 1;
    return this.compliance.calendar(currentUser.orgId, y, m);
  }
}
