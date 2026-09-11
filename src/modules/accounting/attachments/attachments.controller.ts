import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
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
import type { AttachableDocumentType } from "../../../db/schema";
import { AttachmentsService } from "./attachments.service";
import {
  attachDocumentFileSchema,
  attachableDocumentTypeSchema,
  documentIdParamSchema,
  listAttachmentsSchema,
  type AttachDocumentFileInput,
  type ListAttachmentsQuery,
} from "./dto/attachments.schemas";

/**
 * Files hanging off an accounting document (`09-feature-backlog.md` §N, v1).
 *
 * One surface for every document kind rather than seven near-identical ones,
 * because `document_type` is a path segment and the service resolves the
 * document behind it on every call. The cost of that choice is the permission
 * gate: it has to be a key that spans accounting rather than the per-family
 * key (`accounting:receivables:read`, `accounting:payables:read`, …) a static
 * decorator cannot vary. There is no `accounting:attachments:*` pair in the
 * catalog, so reads use `accounting:read`, attaching uses `accounting:create`
 * and removing uses `accounting:update` — all three already exist and none had
 * to be invented.
 */
@RequireModule("accounting")
@Controller("accounting/documents")
@UseGuards(JwtAuthGuard)
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Get(":documentType/:documentId/attachments")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:attachments:read")
  list(
    @Param("documentType", new ZodValidationPipe(attachableDocumentTypeSchema))
    documentType: AttachableDocumentType,
    @Param("documentId", new ZodValidationPipe(documentIdParamSchema)) documentId: string,
    @Query(new ZodValidationPipe(listAttachmentsSchema)) query: ListAttachmentsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.attachments.list(u.orgId, documentType, documentId, query);
  }

  @Post(":documentType/:documentId/attachments")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:attachments:manage")
  @HttpCode(201)
  attach(
    @Param("documentType", new ZodValidationPipe(attachableDocumentTypeSchema))
    documentType: AttachableDocumentType,
    @Param("documentId", new ZodValidationPipe(documentIdParamSchema)) documentId: string,
    @Body(new ZodValidationPipe(attachDocumentFileSchema)) body: AttachDocumentFileInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.attachments.attach(u.orgId, u.userId, documentType, documentId, body);
  }

  @Get("attachments/:attachmentId")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:attachments:read")
  get(@Param("attachmentId") attachmentId: string, @CurrentUser() u: CurrentUserContext) {
    return this.attachments.get(u.orgId, attachmentId);
  }

  /** The bytes, streamed back through the API so the permission gate still applies. */
  @Get("attachments/:attachmentId/content")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:attachments:read")
  async download(
    @Param("attachmentId") attachmentId: string,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.attachments.download(u.orgId, attachmentId);
    res.setHeader("Content-Type", file.mimeType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${file.fileName.replace(/[^A-Za-z0-9._-]+/g, "-")}"`,
    );
    res.setHeader("Content-Length", String(file.buffer.length));
    res.send(file.buffer);
  }

  /** Soft delete: the file leaves the list, the document is untouched. */
  @Delete("attachments/:attachmentId")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:attachments:manage")
  remove(@Param("attachmentId") attachmentId: string, @CurrentUser() u: CurrentUserContext) {
    return this.attachments.remove(u.orgId, attachmentId);
  }
}
