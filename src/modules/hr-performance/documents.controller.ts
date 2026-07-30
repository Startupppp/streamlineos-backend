import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { AccessService } from "../access/access.service";
import { resolveDocumentsScope } from "./performance-scope";
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
import { RequireModule } from "../../common/rbac/require-module.decorator";

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
  ) {}

  @Get("documents")
  @RequirePermission("hr:documents:view")
  async listDocuments(
    @Query(new ZodValidationPipe(listDocumentsSchema)) filters: ListDocumentsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const scope = await resolveDocumentsScope(this.access, u);
    return this.documents.listDocuments(u.orgId, u.userId, scope, filters);
  }

  @Post("documents")
  @HttpCode(201)
  @RequirePermission("hr:documents:view")
  createDocument(
    @Body(new ZodValidationPipe(createDocumentSchema)) body: CreateDocumentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const isAdmin = u.isOrgOwner;
    return this.documents.createDocument(u.orgId, u.userId, isAdmin, body);
  }

  @Get("documents/stats")
  @RequirePermission("hr:documents:view")
  async documentStats(@CurrentUser() u: CurrentUserContext) {
    const scope = await resolveDocumentsScope(this.access, u);
    return this.documents.stats(u.orgId, u.userId, scope);
  }

  @Patch("documents/:documentId")
  @RequirePermission("hr:documents:view")
  updateDocument(
    @Param("documentId", ParseIntPipe) documentId: number,
    @Body(new ZodValidationPipe(updateDocumentSchema)) body: UpdateDocumentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const isAdmin = u.isOrgOwner;
    return this.documents.updateDocument(
      u.orgId,
      u.userId,
      isAdmin,
      documentId,
      body,
    );
  }

  @Delete("documents/:documentId")
  @HttpCode(204)
  @RequirePermission("hr:documents:manage")
  async deleteDocument(
    @Param("documentId", ParseIntPipe) documentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const isAdmin = u.isOrgOwner;
    await this.documents.deleteDocument(u.orgId, u.userId, isAdmin, documentId);
  }

  @Get("document-expiry")
  @RequirePermission("hr:documents:view")
  documentExpiry(
    @Query("days") days: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const daysAhead = Math.min(Math.max(Number(days) || 30, 1), 365);
    return this.documents.expiry(u.orgId, daysAhead);
  }

  @Get("compliance")
  @RequirePermission("hr:documents:view")
  async listCompliance(@CurrentUser() u: CurrentUserContext) {
    const scope = await resolveDocumentsScope(this.access, u);
    return this.compliance.listAcknowledgments(u.orgId, u.userId, scope);
  }

  @Post("compliance")
  @HttpCode(201)
  @RequirePermission("hr:compliance:manage")
  sendCompliance(
    @Body(new ZodValidationPipe(sendAckSchema)) body: SendAckInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.compliance.sendAcknowledgments(u.orgId, body);
  }

  @Patch("compliance")
  @RequirePermission("hr:documents:view")
  acknowledgeCompliance(
    @Body(new ZodValidationPipe(ackSchema)) body: AckInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.compliance.acknowledge(u.orgId, u.userId, body);
  }

  @Get("compliance/statutory")
  @RequirePermission("hr:compliance:manage")
  statutory(@CurrentUser() u: CurrentUserContext) {
    return this.compliance.statutory(u.orgId);
  }

  @Get("rich-documents")
  @RequirePermission("hr:documents:view")
  listRichDocuments(
    @Query(new ZodValidationPipe(listRichDocumentsSchema)) query: ListRichDocumentsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.richDocuments.list(u.orgId, query);
  }

  @Post("rich-documents")
  @HttpCode(201)
  @RequirePermission("hr:documents:manage")
  createRichDocument(
    @Body(new ZodValidationPipe(createRichDocumentSchema)) body: CreateRichDocumentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.richDocuments.create(u.orgId, u.userId, body);
  }

  @Get("rich-documents/:documentId")
  @RequirePermission("hr:documents:view")
  getRichDocument(
    @Param("documentId", ParseIntPipe) documentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.richDocuments.get(u.orgId, documentId);
  }

  @Patch("rich-documents/:documentId/publish")
  @RequirePermission("hr:documents:manage")
  publishRichDocument(
    @Param("documentId", ParseIntPipe) documentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.richDocuments.togglePublish(u.orgId, documentId);
  }

  @Patch("rich-documents/:documentId")
  @RequirePermission("hr:documents:manage")
  updateRichDocument(
    @Param("documentId", ParseIntPipe) documentId: number,
    @Body(new ZodValidationPipe(updateRichDocumentSchema)) body: UpdateRichDocumentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.richDocuments.update(u.orgId, u.userId, documentId, body);
  }

  @Delete("rich-documents/:documentId")
  @HttpCode(204)
  @RequirePermission("hr:documents:manage")
  async deleteRichDocument(
    @Param("documentId", ParseIntPipe) documentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.richDocuments.remove(u.orgId, documentId);
  }

  @Get("documents/letters")
  @RequirePermission("hr:documents:view")
  listLetters(
    @Query("employeeId") employeeId: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.letters.listLetters(u.orgId, employeeId);
  }

  @Post("documents/letters/render")
  @RequirePermission("hr:documents:manage")
  @HttpCode(200)
  renderLetter(
    @Body(new ZodValidationPipe(renderLetterSchema)) body: RenderLetterInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.letters.renderLetter(u.orgId, u.userId, body);
  }

  @Post("documents/letters")
  @RequirePermission("hr:documents:manage")
  @HttpCode(201)
  saveLetter(
    @Body(new ZodValidationPipe(saveLetterSchema)) body: SaveLetterInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.letters.saveLetter(u.orgId, u.userId, body);
  }

  @Get("compliance/calendar")
  @RequirePermission("hr:compliance:manage")
  complianceCalendar(
    @Query("year") year: string | undefined,
    @Query("month") month: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const y = parseInt(year ?? String(new Date().getFullYear()), 10);
    const m = parseInt(month ?? String(new Date().getMonth() + 1), 10);
    return this.compliance.calendar(u.orgId, y, m);
  }
}
