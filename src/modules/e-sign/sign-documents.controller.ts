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
import { z } from "zod";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Request } from "express";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { Validate } from "../../common/validation/validate.decorator";
import { SignDocumentsService } from "./sign-documents.service";
import { uploadDocumentMetaSchema, type UploadDocumentMetaInput } from "./dto/e-sign.schemas";
import { BodylessAction } from "../../common/openapi/zod-operation-contracts";

function clientIp(req: Request): string | undefined {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (raw?.split(",")[0]?.trim() || req.ip)?.slice(0, 100);
}

const envelopeIdParams = z.object({ envelopeId: z.coerce.number().int().positive() }).strict();
const documentIdParams = z.object({ documentId: z.coerce.number().int().positive() }).strict();

@RequireModule("sign")
@Controller("sign")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class SignDocumentsController {
  constructor(private readonly documents: SignDocumentsService) {}

  @Post("documents/upload")
  @HttpCode(201)
  @RequirePermission("sign:documents:upload")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 200 * 1024 * 1024 } }))
  @Validate({ query: uploadDocumentMetaSchema })
  @BodylessAction()
  async upload(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Query("envelopeId", ParseIntPipe) envelopeId: number,
    @Query() query: UploadDocumentMetaInput,
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
  @Validate({ params: envelopeIdParams })
  list(@Param("envelopeId", ParseIntPipe) envelopeId: number, @CurrentUser() u: CurrentUserContext) {
    return this.documents.list(u.orgId, envelopeId);
  }

  @Get("documents/:documentId/preview")
  @RequirePermission("sign:documents:view")
  @Validate({ params: documentIdParams })
  preview(@Param("documentId", ParseIntPipe) documentId: number, @CurrentUser() u: CurrentUserContext) {
    return this.documents.getPreviewUrl(u.orgId, documentId);
  }

  @Delete("documents/:documentId")
  @RequirePermission("sign:documents:upload")
  @Validate({ params: documentIdParams })
  async remove(@Param("documentId", ParseIntPipe) documentId: number, @CurrentUser() u: CurrentUserContext) {
    await this.documents.delete(u.orgId, documentId);
    return { success: true };
  }
}
