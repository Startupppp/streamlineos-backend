import {
  Body,
  Controller,
  Delete,
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
  createDocumentSchema,
  createRichDocumentSchema,
  listDocumentsSchema,
  listRichDocumentsSchema,
  renderLetterSchema,
  saveLetterSchema,
  sendAckSchema,
  updateDocumentSchema,
  updateRichDocumentSchema,
  type AckInput,
  type CreateDocumentInput,
  type CreateRichDocumentInput,
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
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";

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

  @Get("documents")
  @RequirePermission("hr:documents:view")
  @Validate({ query: listDocumentsSchema })
  async listDocuments(
    @Query() filters: ListDocumentsInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    const scope = await resolveDocumentsScope(this.access, currentUser);
    return this.documents.listDocuments(currentUser.orgId, currentUser.userId, scope, filters);
  }

  @Post("documents")
  @HttpCode(201)
  @RequirePermission("hr:documents:manage")
  @Validate({ body: createDocumentSchema })
  async createDocument(
    @Body() body: CreateDocumentInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    const scope = await resolveDocumentsManageScope(this.access, currentUser);
    return this.documents.createDocument(currentUser.orgId, currentUser.userId, scope, body);
  }

  @Get("documents/:documentId/file")
  @RequirePermission("hr:documents:view")
  @Validate({ params: documentIdParams })
  async getDocumentFile(
    @Param("documentId", ParseIntPipe) documentId: number,
    @CurrentUser() currentUser: CurrentUserContext,
  ): Promise<{ url: string; fileName: string; expiresIn: number }> {
    const scope = await resolveDocumentsScope(this.access, currentUser);
    const document = await this.documents.getFileReference(
      currentUser.orgId,
      currentUser.userId,
      scope,
      documentId,
    );
    const fileKey = this.storage.getFileKeyFromUrl(document.fileUrl);
    if (!this.storage.isValidFileKey(fileKey)) {
      throw new NotFoundException("Document file is unavailable.");
    }

    const expiresIn = 300;
    const url = await this.storage.getFileUrl(currentUser.orgId, fileKey, expiresIn);
    await this.audit.logCritical({
      action: "hr.document_viewed",
      userId: currentUser.userId,
      orgId: currentUser.orgId,
      targetId: String(document.documentId),
      targetType: "document",
      metadata: { fileName: document.fileName },
    });
    return { url, fileName: document.fileName, expiresIn };
  }

  @Get("documents/stats")
  @RequirePermission("hr:documents:view")
  async documentStats(@CurrentUser() currentUser: CurrentUserContext) {
    const scope = await resolveDocumentsScope(this.access, currentUser);
    return this.documents.stats(currentUser.orgId, currentUser.userId, scope);
  }

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
      currentUser.orgId,
      currentUser.userId,
      scope,
      documentId,
      body,
    );
  }

  @Delete("documents/:documentId")
  @HttpCode(204)
  @RequirePermission("hr:documents:manage")
  @Validate({ params: documentIdParams })
  async deleteDocument(
    @Param("documentId", ParseIntPipe) documentId: number,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    const scope = await resolveDocumentsManageScope(this.access, currentUser);
    await this.documents.deleteDocument(currentUser.orgId, currentUser.userId, scope, documentId);
  }

  @Get("document-expiry")
  @RequirePermission("hr:documents:view")
  async documentExpiry(
    @Query("days") days: string | undefined,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    const daysAhead = Math.min(Math.max(Number(days) || 30, 1), 365);
    const scope = await resolveDocumentsScope(this.access, currentUser);
    return this.documents.expiry(currentUser.orgId, currentUser.userId, scope, daysAhead);
  }

  @Get("compliance")
  @RequirePermission("hr:documents:view")
  async listCompliance(@CurrentUser() currentUser: CurrentUserContext) {
    const scope = await resolveDocumentsScope(this.access, currentUser);
    return this.compliance.listAcknowledgments(currentUser.orgId, currentUser.userId, scope);
  }

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

  @Patch("compliance")
  @RequirePermission("hr:documents:view")
  @Validate({ body: ackSchema })
  acknowledgeCompliance(
    @Body() body: AckInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.compliance.acknowledge(currentUser.orgId, currentUser.userId, body);
  }

  @Get("compliance/statutory")
  @RequirePermission("hr:compliance:manage")
  statutory(@CurrentUser() currentUser: CurrentUserContext) {
    return this.compliance.statutory(currentUser.orgId);
  }

  @Get("rich-documents")
  @RequirePermission("hr:documents:view")
  @Validate({ query: listRichDocumentsSchema })
  listRichDocuments(
    @Query() query: ListRichDocumentsInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.richDocuments.list(currentUser.orgId, query);
  }

  @Post("rich-documents")
  @HttpCode(201)
  @RequirePermission("hr:documents:manage")
  @Validate({ body: createRichDocumentSchema })
  createRichDocument(
    @Body() body: CreateRichDocumentInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.richDocuments.create(currentUser.orgId, currentUser.userId, body);
  }

  @Get("rich-documents/:documentId")
  @RequirePermission("hr:documents:view")
  @Validate({ params: documentIdParams })
  getRichDocument(
    @Param("documentId", ParseIntPipe) documentId: number,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.richDocuments.get(currentUser.orgId, documentId);
  }

  @Patch("rich-documents/:documentId/publish")
  @BodylessAction()
  @Idempotent("hr.performance-document.publish")
  @RequirePermission("hr:documents:manage")
  @Validate({ params: documentIdParams })
  publishRichDocument(
    @Param("documentId", ParseIntPipe) documentId: number,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.richDocuments.togglePublish(currentUser.orgId, documentId);
  }

  @Patch("rich-documents/:documentId")
  @RequirePermission("hr:documents:manage")
  @Validate({ params: documentIdParams, body: updateRichDocumentSchema })
  updateRichDocument(
    @Param("documentId", ParseIntPipe) documentId: number,
    @Body() body: UpdateRichDocumentInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.richDocuments.update(currentUser.orgId, currentUser.userId, documentId, body);
  }

  @Delete("rich-documents/:documentId")
  @HttpCode(204)
  @RequirePermission("hr:documents:manage")
  @Validate({ params: documentIdParams })
  async deleteRichDocument(
    @Param("documentId", ParseIntPipe) documentId: number,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    await this.richDocuments.remove(currentUser.orgId, documentId);
  }

  @Get("documents/letters")
  @RequirePermission("hr:documents:view")
  listLetters(
    @Query("employmentId") employmentId: string | undefined,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.letters.listLetters(currentUser.orgId, employmentId);
  }

  @Post("documents/letters/render")
  @RequirePermission("hr:documents:manage")
  @HttpCode(200)
  @Validate({ body: renderLetterSchema })
  renderLetter(
    @Body() body: RenderLetterInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.letters.renderLetter(currentUser.orgId, body);
  }

  @Post("documents/letters")
  @RequirePermission("hr:documents:manage")
  @HttpCode(201)
  @Validate({ body: saveLetterSchema })
  saveLetter(
    @Body() body: SaveLetterInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.letters.saveLetter(currentUser.orgId, currentUser.userId, body);
  }

  @Get("compliance/calendar")
  @RequirePermission("hr:compliance:manage")
  complianceCalendar(
    @Query("year") year: string | undefined,
    @Query("month") month: string | undefined,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    const y = parseInt(year ?? String(new Date().getFullYear()), 10);
    const m = parseInt(month ?? String(new Date().getMonth() + 1), 10);
    return this.compliance.calendar(currentUser.orgId, y, m);
  }
}
