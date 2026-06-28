import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
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
import { canManageDocuments } from "./ability.helpers";
import { DocumentsService } from "./documents.service";
import { ComplianceService } from "./compliance.service";
import { RichDocumentsService } from "./rich-documents.service";
import {
  ackSchema,
  createDocumentSchema,
  createRichDocumentSchema,
  listDocumentsSchema,
  sendAckSchema,
  updateDocumentSchema,
  updateRichDocumentSchema,
  type AckInput,
  type CreateDocumentInput,
  type CreateRichDocumentInput,
  type ListDocumentsInput,
  type SendAckInput,
  type UpdateDocumentInput,
  type UpdateRichDocumentInput,
} from "./dto/documents.schemas";

@Controller("hr")
@UseGuards(JwtAuthGuard)
export class DocumentsController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly compliance: ComplianceService,
    private readonly richDocuments: RichDocumentsService,
  ) {}

  @Get("documents")
  listDocuments(
    @Query(new ZodValidationPipe(listDocumentsSchema)) filters: ListDocumentsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const isAdmin = canManageDocuments(u);
    if (filters.userId && filters.userId !== u.userId && !isAdmin) {
      throw new ForbiddenException("Not authorized to view other users' documents.");
    }
    return this.documents.listDocuments(u.orgId, u.userId, isAdmin, filters);
  }

  @Post("documents")
  @HttpCode(201)
  createDocument(
    @Body(new ZodValidationPipe(createDocumentSchema)) body: CreateDocumentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.documents.createDocument(u.orgId, u.userId, canManageDocuments(u), body);
  }

  @Get("documents/stats")
  documentStats(@CurrentUser() u: CurrentUserContext) {
    return this.documents.stats(u.orgId, u.userId, canManageDocuments(u));
  }

  @Patch("documents/:documentId")
  updateDocument(
    @Param("documentId", ParseIntPipe) documentId: number,
    @Body(new ZodValidationPipe(updateDocumentSchema)) body: UpdateDocumentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.documents.updateDocument(
      u.orgId,
      u.userId,
      canManageDocuments(u),
      documentId,
      body,
    );
  }

  @Delete("documents/:documentId")
  deleteDocument(
    @Param("documentId", ParseIntPipe) documentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.documents.deleteDocument(u.orgId, u.userId, canManageDocuments(u), documentId);
  }

  @Get("document-expiry")
  documentExpiry(
    @Query("days") days: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const daysAhead = Number(days) || 30;
    return this.documents.expiry(u.orgId, daysAhead);
  }

  @Get("compliance")
  listCompliance(@CurrentUser() u: CurrentUserContext) {
    return this.compliance.listAcknowledgments(u.orgId, u.userId, canManageDocuments(u));
  }

  @Post("compliance")
  @HttpCode(201)
  sendCompliance(
    @Body(new ZodValidationPipe(sendAckSchema)) body: SendAckInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!canManageDocuments(u)) {
      throw new ForbiddenException("Only admins can send acknowledgment requests.");
    }
    return this.compliance.sendAcknowledgments(u.orgId, body);
  }

  @Patch("compliance")
  acknowledgeCompliance(
    @Body(new ZodValidationPipe(ackSchema)) body: AckInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.compliance.acknowledge(u.userId, body);
  }

  @Get("compliance/statutory")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:compliance:manage")
  statutory(@CurrentUser() u: CurrentUserContext) {
    return this.compliance.statutory(u.orgId);
  }

  @Get("rich-documents")
  listRichDocuments(@CurrentUser() u: CurrentUserContext) {
    return this.richDocuments.list(u.orgId);
  }

  @Post("rich-documents")
  @HttpCode(201)
  createRichDocument(
    @Body(new ZodValidationPipe(createRichDocumentSchema)) body: CreateRichDocumentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.richDocuments.create(u.orgId, u.userId, body);
  }

  @Get("rich-documents/:documentId")
  getRichDocument(
    @Param("documentId", ParseIntPipe) documentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.richDocuments.get(u.orgId, documentId);
  }

  @Patch("rich-documents/:documentId/publish")
  publishRichDocument(
    @Param("documentId", ParseIntPipe) documentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.richDocuments.togglePublish(u.orgId, documentId);
  }

  @Patch("rich-documents/:documentId")
  updateRichDocument(
    @Param("documentId", ParseIntPipe) documentId: number,
    @Body(new ZodValidationPipe(updateRichDocumentSchema)) body: UpdateRichDocumentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.richDocuments.update(u.orgId, u.userId, documentId, body);
  }

  @Delete("rich-documents/:documentId")
  deleteRichDocument(
    @Param("documentId", ParseIntPipe) documentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.richDocuments.remove(u.orgId, documentId);
  }
}
