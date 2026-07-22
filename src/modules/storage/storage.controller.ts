import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  InternalServerErrorException,
  NotFoundException,
  Post,
  Query,
  Res,
  ServiceUnavailableException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { eq, ilike } from "drizzle-orm";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { AuditService } from "../../common/audit/audit.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { documents, organizationMembers, onboardingDocuments, expenses, reimbursements, handbookVersions } from "../../db/schema";
import { StorageService, type FileStreamResult } from "./storage.service";
import { validateMagicBytes } from "./file-signatures";

const MAX_UPLOAD_SIZE = 10 * 1024 * 1024;

const ALLOWED_UPLOAD_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

@Controller("storage")
@UseGuards(JwtAuthGuard)
export class StorageController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  @Post("upload")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 50 * 1024 * 1024 } }))
  async upload(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body("folder") folderField: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<{ url: string; key: string; size: number; mimeType: string }> {
    if (!this.storage.isConfigured()) {
      throw new ServiceUnavailableException("File storage is not available");
    }
    if (!file) throw new BadRequestException("No file provided");

    const rawFolder = folderField && folderField.length > 0 ? folderField : "uploads";
    const folder = rawFolder.replace(/[^a-zA-Z0-9_-]/g, "-");

    if (file.size > MAX_UPLOAD_SIZE) throw new BadRequestException("File too large (max 10MB)");
    if (!ALLOWED_UPLOAD_TYPES.includes(file.mimetype)) {
      throw new BadRequestException("File type not allowed");
    }
    if (!validateMagicBytes(file.buffer, file.mimetype)) {
      throw new BadRequestException("File content does not match declared type");
    }

    try {
      const result = await this.storage.uploadCompressed(
        file.buffer,
        folder,
        file.originalname,
        file.mimetype,
      );
      this.audit.log({
        action: "file.upload",
        userId: u.userId,
        orgId: u.orgId,
        metadata: { fileKey: result.key, fileSize: result.size, mimeType: result.mimeType },
      });
      return result;
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof ServiceUnavailableException) {
        throw error;
      }
      throw new InternalServerErrorException("Failed to upload file");
    }
  }

  @Get("download")
  async download(
    @Query("url") urlParam: string | undefined,
    @Query("key") keyParam: string | undefined,
    @Query("expiresIn") expiresInParam: string | undefined,
    @Query("attachment") attachmentParam: string | undefined,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ): Promise<void> {
    if (!this.storage.isConfigured()) {
      throw new ServiceUnavailableException("Cloud storage not configured");
    }

    const rawExpires = parseInt(expiresInParam ?? "3600", 10);
    const expiresIn = Number.isNaN(rawExpires) ? 3600 : Math.min(Math.max(rawExpires, 60), 86400);
    const attachment = attachmentParam === "1";

    if (!urlParam && !keyParam) throw new BadRequestException("URL or key required");

    const fileKey = keyParam || (urlParam ? this.storage.getFileKeyFromUrl(urlParam) : "");
    if (!fileKey || !this.storage.isValidFileKey(fileKey)) {
      throw new BadRequestException("Invalid file reference");
    }

    const member = await this.db.query.organizationMembers.findFirst({
      where: eq(organizationMembers.userId, u.userId),
    });
    const orgId = member?.orgId ?? u.orgId;

    const fileOwnerOrgId = await this.resolveFileOwnerOrgId(fileKey);
    if (fileOwnerOrgId !== null && fileOwnerOrgId !== orgId) {
      throw new ForbiddenException("Access denied");
    }

    this.audit.log({ action: "file.download", userId: u.userId, orgId, metadata: { fileKey } });

    if (attachment) {
      const stream = await this.openStream(fileKey, "File not found");
      const filename = this.storage.getFileNameFromKey(fileKey);
      res.setHeader("Content-Type", stream.contentType || this.storage.getMimeType(fileKey));
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename.replace(/"/g, "%22")}"`,
      );
      this.pipe(stream.body, res);
      return;
    }

    const signedUrl = await this.storage.getFileUrl(fileKey, expiresIn);
    res.json({ url: signedUrl });
  }

  @Get("image")
  async image(
    @Query("key") keyParam: string | undefined,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ): Promise<void> {
    if (!keyParam || !this.storage.isValidFileKey(keyParam)) {
      throw new BadRequestException("Invalid key parameter");
    }
    if (!this.storage.isConfigured()) {
      throw new ServiceUnavailableException("Storage not available");
    }

    const member = await this.db.query.organizationMembers.findFirst({
      where: eq(organizationMembers.userId, u.userId),
    });
    if (!member) throw new ForbiddenException("Forbidden");

    const stream = await this.openStream(keyParam, "Not found");
    res.setHeader("Content-Type", stream.contentType || this.storage.getMimeType(keyParam));
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    this.pipe(stream.body, res);
  }

  /**
   * The `documents` table doesn't track every file type — onboarding documents, expense/
   * reimbursement receipts, and handbook attachments live in their own tables with no
   * central registry. Storage keys aren't org-namespaced, so this is the only place cross-org
   * ownership can be checked; silently skipping a table here reopens the isolation gap for
   * that file type. Returns the owning orgId, or null if the key isn't tracked anywhere.
   */
  private async resolveFileOwnerOrgId(fileKey: string): Promise<string | null> {
    const like = `%${fileKey}%`;
    const [doc, onboardingDoc, expense, reimbursement, handbookVersion] = await Promise.all([
      this.db.query.documents.findFirst({ where: ilike(documents.fileUrl, like) }),
      this.db.query.onboardingDocuments.findFirst({ where: ilike(onboardingDocuments.fileUrl, like) }),
      this.db.query.expenses.findFirst({ where: ilike(expenses.receiptUrl, like) }),
      this.db.query.reimbursements.findFirst({ where: ilike(reimbursements.receiptUrl, like) }),
      this.db.query.handbookVersions.findFirst({ where: ilike(handbookVersions.documentUrl, like) }),
    ]);
    return (
      doc?.orgId ?? onboardingDoc?.orgId ?? expense?.orgId ?? reimbursement?.orgId ?? handbookVersion?.orgId ?? null
    );
  }

  private async openStream(key: string, notFoundMessage: string): Promise<FileStreamResult> {
    try {
      return await this.storage.getFileStream(key);
    } catch {
      throw new NotFoundException(notFoundMessage);
    }
  }

  private pipe(body: NodeJS.ReadableStream, res: Response): void {
    body.on("error", () => {
      if (!res.headersSent) res.status(500);
      res.end();
    });
    body.pipe(res);
  }
}
