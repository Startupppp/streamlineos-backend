import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
  UploadedFile,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Request } from "express";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { SignDocumentsService } from "./sign-documents.service";
import { uploadDocumentMetaSchema, type UploadDocumentMetaInput } from "./dto/e-sign.schemas";

function clientIp(req: Request): string | undefined {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (raw?.split(",")[0]?.trim() || req.ip)?.slice(0, 100);
}

@RequireModule("sign")
@Controller("sign")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class SignDocumentsController {
  constructor(private readonly documents: SignDocumentsService) {}

  @Post("documents/upload")
  @HttpCode(201)
  @RequirePermission("sign:documents:upload")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 200 * 1024 * 1024 } }))
  async upload(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Query("envelopeId", ParseIntPipe) envelopeId: number,
    @Query(new ZodValidationPipe(uploadDocumentMetaSchema)) query: UploadDocumentMetaInput,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    if (!file) throw new BadRequestException("No file provided");
    return this.documents.upload(
      envelopeId,
      { buffer: file.buffer, originalName: file.originalname, mimeType: file.mimetype, size: file.size },
      query.orderIndex,
      { orgId: u.orgId, userId: u.userId, ipAddress: clientIp(req), userAgent: req.headers["user-agent"] },
    );
  }

  @Get("envelopes/:envelopeId/documents")
  @RequirePermission("sign:documents:view")
  list(@Param("envelopeId", ParseIntPipe) envelopeId: number, @CurrentUser() u: CurrentUserContext) {
    return this.documents.list(u.orgId, envelopeId);
  }

  @Get("documents/:documentId/preview")
  @RequirePermission("sign:documents:view")
  preview(@Param("documentId", ParseIntPipe) documentId: number, @CurrentUser() u: CurrentUserContext) {
    return this.documents.getPreviewUrl(u.orgId, documentId);
  }

  @Delete("documents/:documentId")
  @RequirePermission("sign:documents:upload")
  async remove(@Param("documentId", ParseIntPipe) documentId: number, @CurrentUser() u: CurrentUserContext, @Req() req: Request) {
    await this.documents.delete(u.orgId, documentId, { orgId: u.orgId, userId: u.userId, ipAddress: clientIp(req) });
    return { success: true };
  }
}
