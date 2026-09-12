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
import { actingMembershipId } from "../../common/auth/principal";
import { Validate } from "../../common/validation/validate.decorator";
import { AccessService } from "../access/access.service";
import { SignDocumentsService } from "./sign-documents.service";
import { SignEnvelopeAccessService } from "./sign-envelope-access.service";
import { resolveEnvelopeViewScope } from "./sign-envelope-scope";
import { uploadDocumentMetaSchema, type UploadDocumentMetaInput } from "./dto/e-sign.schemas";
import { MultipartAction, ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import {
  uploadDocumentResponseSchema,
  listDocumentsResponseSchema,
  previewDocumentResponseSchema,
} from "./dto/e-sign-response.schemas";
import { successSchema } from "../../common/openapi/response-envelopes";
import { resolveClientIp } from "../../common/http/client-ip";


const envelopeIdParams = z.object({ envelopeId: z.coerce.number().int().positive() }).strict();
const documentIdParams = z.object({ documentId: z.coerce.number().int().positive() }).strict();

@RequireModule("sign")
@Controller("sign")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class SignDocumentsController {
  constructor(
    private readonly documents: SignDocumentsService,
    private readonly access: AccessService,
    private readonly envelopeAccess: SignEnvelopeAccessService,
  ) {}

  @Post("documents/upload")
  @MultipartAction({ file: "file" })
  @HttpCode(201)
  @RequirePermission("sign:documents:upload")
  @ResponseSchema(uploadDocumentResponseSchema)
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 200 * 1024 * 1024 } }))
  @Validate({ query: uploadDocumentMetaSchema })
  async upload(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Query() query: UploadDocumentMetaInput,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    if (!file) throw new BadRequestException("No file provided");
    await this.envelopeAccess.mustGetActionable(u, query.envelopeId);
    return this.documents.upload(
      query.envelopeId,
      { buffer: file.buffer, originalName: file.originalname, mimeType: file.mimetype, size: file.size },
      query.orderIndex,
      { orgId: u.orgId, userId: u.userId, membershipId: actingMembershipId(u.principal), ipAddress: resolveClientIp(req), userAgent: req.headers["user-agent"] },
    );
  }

  @Get("envelopes/:envelopeId/documents")
  @RequirePermission("sign:documents:view")
  @ResponseSchema(listDocumentsResponseSchema)
  @Validate({ params: envelopeIdParams })
  async list(@Param("envelopeId", ParseIntPipe) envelopeId: number, @CurrentUser() u: CurrentUserContext) {
    const scope = await resolveEnvelopeViewScope(this.access, u);
    return this.documents.list(scope, actingMembershipId(u.principal), envelopeId);
  }

  @Get("documents/:documentId/preview")
  @RequirePermission("sign:documents:view")
  @ResponseSchema(previewDocumentResponseSchema)
  @Validate({ params: documentIdParams })
  async preview(@Param("documentId", ParseIntPipe) documentId: number, @CurrentUser() u: CurrentUserContext) {
    const scope = await resolveEnvelopeViewScope(this.access, u);
    return this.documents.getPreviewUrl(scope, actingMembershipId(u.principal), documentId);
  }

  @Delete("documents/:documentId")
  @RequirePermission("sign:documents:upload")
  @ResponseSchema(successSchema)
  @Validate({ params: documentIdParams })
  async remove(@Param("documentId", ParseIntPipe) documentId: number, @CurrentUser() u: CurrentUserContext) {
    await this.envelopeAccess.mustGetActionableByDocument(u, documentId);
    await this.documents.delete(u.orgId, documentId);
    return { success: true };
  }
}
