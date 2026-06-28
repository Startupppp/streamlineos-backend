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
import { documents, organizationMembers } from "../../db/schema";
import { StorageService, type FileStreamResult } from "./storage.service";

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

const FILE_SIGNATURES: Record<string, number[][]> = {
  "image/jpeg": [[0xff, 0xd8, 0xff]],
  "image/png": [[0x89, 0x50, 0x4e, 0x47]],
  "image/gif": [
    [0x47, 0x49, 0x46, 0x38, 0x37, 0x61],
    [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
  ],
  "image/webp": [[0x52, 0x49, 0x46, 0x46]],
  "application/pdf": [[0x25, 0x50, 0x44, 0x46]],
  "application/msword": [[0xd0, 0xcf, 0x11, 0xe0]],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [[0x50, 0x4b, 0x03, 0x04]],
  "application/vnd.ms-excel": [[0xd0, 0xcf, 0x11, 0xe0]],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [[0x50, 0x4b, 0x03, 0x04]],
};

function validateMagicBytes(buffer: Buffer, mimeType: string): boolean {
  const signatures = FILE_SIGNATURES[mimeType];
  if (!signatures) return true;
  if (buffer.length < 12) return false;
  const matchesSignature = signatures.some((sig) => sig.every((byte, i) => buffer[i] === byte));
  if (!matchesSignature) return false;
  if (mimeType === "image/webp") {
    return buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50;
  }
  return true;
}

@Controller("storage")
@UseGuards(JwtAuthGuard)
export class StorageController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  @Post("upload")
  @UseInterceptors(FileInterceptor("file"))
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
      const result = await this.storage.uploadFile(
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

    const fileRecord = await this.db.query.documents.findFirst({
      where: ilike(documents.fileUrl, `%${fileKey}%`),
    });
    if (fileRecord && fileRecord.orgId !== orgId) {
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
