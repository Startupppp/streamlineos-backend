import {
  BadRequestException,
  Body,
  Controller,
  Param,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { FileInterceptor } from "@nestjs/platform-express";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RecruitmentCandidateVaultService } from "./recruitment-candidate-vault.service";
import { StorageService } from "../../storage/storage.service";
import { FileQuarantineService } from "../../storage/file-quarantine.service";
import { AuditService } from "../../../common/audit/audit.service";
import { validateMagicBytes } from "../../storage/file-signatures";
import { createHash } from "crypto";
import {
  runInTenantTransaction,
} from "../../../common/tenant/run-in-tenant-transaction";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { Inject } from "@nestjs/common";
import { type Db } from "../../../db/drizzle.module";
import { z } from "zod";
import { MultipartAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { vaultDocumentSchema } from "./dto/recruitment-candidate-records-response.schemas";

const MAX_UPLOAD_SIZE = 10 * 1024 * 1024;
const ALLOWED_UPLOAD_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

@Controller("hr/recruitment/candidates/:candidateId/documents")
@UseGuards(JwtAuthGuard)
export class RecruitmentCandidateDocumentsController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly vaultService: RecruitmentCandidateVaultService,
    private readonly storage: StorageService,
    private readonly quarantine: FileQuarantineService,
    private readonly audit: AuditService,
  ) {}

  @Post("upload")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:manage")
  @ResponseSchema(vaultDocumentSchema)
  @MultipartAction({ file: "file", fileRequired: true, fields: { documentType: "string" } })
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_UPLOAD_SIZE } }))
  async upload(
    @CurrentUser() u: CurrentUserContext,
    @Param("candidateId") candidateIdParam: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body("documentType") documentType?: string,
  ) {
    if (!file) throw new BadRequestException("No file provided");
    const candidateId = parseInt(candidateIdParam, 10);
    if (isNaN(candidateId)) throw new BadRequestException("Invalid candidate ID");

    if (file.size > MAX_UPLOAD_SIZE)
      throw new BadRequestException("File too large (max 10MB)");
    if (!ALLOWED_UPLOAD_TYPES.includes(file.mimetype))
      throw new BadRequestException("File type not allowed");
    if (!validateMagicBytes(file.buffer, file.mimetype))
      throw new BadRequestException("File content does not match declared type");

    const { orgId, userId } = u;

    const { key, quarantineId } = await runInTenantTransaction(
      this.db,
      async () => {
        const folder = "hr-documents";
        const { key } = await this.storage.planUpload(
          orgId,
          file.buffer,
          folder,
          file.originalname,
          file.mimetype,
        );
        const sha256 = createHash("sha256").update(file.buffer).digest("hex");

        const quarantineId = await this.quarantine.begin({
          orgId,
          storageKey: key,
          filename: file.originalname,
          mimeType: file.mimetype,
          fileSizeBytes: file.size,
          sha256,
          uploadedBy: userId,
        });

        await this.storage.compressToKey(
          orgId,
          file.buffer,
          key,
          file.originalname,
          file.mimetype,
        );

        await this.quarantine.recordMeasuredObject(quarantineId, {
          fileSizeBytes: file.size,
          mimeType: file.mimetype,
        });
        await this.quarantine.markClean(quarantineId);

        return { key, quarantineId };
      },
      { orgId },
    );

    const doc = await this.vaultService.addVaultDocument(orgId, userId, candidateId, {
      filename: file.originalname,
      s3Key: key,
      fileUrl: await this.storage.getFileUrl(orgId, key, 3600),
      fileType: file.mimetype,
      fileSize: file.size,
      documentType: documentType as any,
    });

    this.audit.log({
      action: "candidate.vault-document.upload",
      userId,
      orgId,
      metadata: {
        candidateId,
        documentId: doc.id,
        key,
      },
    });

    return doc;
  }
}
