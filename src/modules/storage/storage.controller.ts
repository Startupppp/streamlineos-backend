import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  Post,
  Query,
  Res,
  ServiceUnavailableException,
  UnprocessableEntityException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { createHash } from "crypto";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { AuthorizedInService } from "../../common/auth/authorized-in-service.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { AuditService } from "../../common/audit/audit.service";
import { MultipartAction } from "../../common/openapi/zod-operation-contracts";
import { runInNewTenantTransaction, runOutsideTenantContext } from "../../common/tenant";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { StorageService, type FileStreamResult, type UploadJobResult } from "./storage.service";
import { validateMagicBytes } from "./file-signatures";
import { isSensitiveFolderRoot, sanitizeFolder } from "./storage-key";
import { assertKeyReadable } from "./storage-read-authorization";
import { FileQuarantineService } from "./file-quarantine.service";
import { MediaTransformRunner } from "./media-transform.runner";
import { ApiOkResponse } from "@nestjs/swagger";
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import { storageUploadResponseSchema } from "./dto/storage-response.schemas";
import { AccessService } from "../access/access.service";
import { AvScanner } from "../../common/security/av-scan";
import { Validate } from "../../common/validation/validate.decorator";
import {
  downloadQuerySchema,
  imageQuerySchema,
  type DownloadQueryInput,
  type ImageQueryInput,
} from "./dto/storage.schemas";

const MAX_UPLOAD_SIZE = 10 * 1024 * 1024;
const ORG_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;
const USER_QUOTA_BYTES = 500 * 1024 * 1024;

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

const GENERIC_SENSITIVE_UPLOAD_PERMISSIONS: Readonly<
  Record<string, readonly string[]>
> = {
  documents: ["hr:documents:manage"],
  "hr-documents": ["hr:documents:manage"],
  onboarding: ["self:onboarding-docs", "hr:onboarding:manage"],
  "onboarding-docs": ["self:onboarding-docs", "hr:onboarding:manage"],
  resignations: ["hr:exit:create", "hr:exit:manage"],
};

@Controller("storage")
@UseGuards(JwtAuthGuard)
export class StorageController {
  private readonly logger = new Logger(StorageController.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly avScanner: AvScanner,
    private readonly quarantine: FileQuarantineService,
    private readonly transforms: MediaTransformRunner,
  ) {}

  @Post("upload")
  @MultipartAction({ file: "file", fields: { folder: "string" } })
  @ResponseSchema(storageUploadResponseSchema)
  @AuthorizedInService("assertUploadAllowed")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_UPLOAD_SIZE } }))
  async upload(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body("folder") folderField: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<UploadJobResult> {
    if (!this.storage.isConfigured())
      throw new ServiceUnavailableException("File storage is not available");
    if (!file) throw new BadRequestException("No file provided");

    const folder = sanitizeFolder(
      folderField && folderField.length > 0 ? folderField : "uploads",
    );

    if (file.size > MAX_UPLOAD_SIZE) throw new BadRequestException("File too large (max 10MB)");
    if (!ALLOWED_UPLOAD_TYPES.includes(file.mimetype))
      throw new BadRequestException("File type not allowed");
    if (!validateMagicBytes(file.buffer, file.mimetype))
      throw new BadRequestException("File content does not match declared type");

    if (!this.transforms.hasCapacity())
      throw new ServiceUnavailableException("Upload processing is saturated — retry shortly");

    const { orgId, userId } = u;
    const body = file.buffer;
    const originalName = file.originalname;
    const originalMimeType = file.mimetype;
    const fileSize = file.size;

    await runInTenantTransaction(
      this.db,
      async () => {
        await this.assertUploadAllowed(folder, u);

        const [orgUsed, userUsed] = await Promise.all([
          this.quarantine.getTotalUsageBytes(orgId),
          this.quarantine.getTotalUsageBytesForUser(orgId, userId),
        ]);
        if (orgUsed + fileSize > ORG_QUOTA_BYTES)
          throw new PayloadTooLargeException("Organization storage quota exceeded");
        if (userUsed + fileSize > USER_QUOTA_BYTES)
          throw new PayloadTooLargeException("User storage quota exceeded");
      },
      { orgId },
    );

    const scanResult = await this.avScanner.scan(body, originalName, originalMimeType);
    if (scanResult.status === "infected")
      throw new UnprocessableEntityException(`Upload rejected: malware detected (${scanResult.threat})`);
    if (scanResult.status === "error")
      throw new ServiceUnavailableException("Malware scan unavailable — upload rejected");

    const { key, plannedMimeType, quarantineId, declaredSha256 } =
      await runInTenantTransaction(
        this.db,
        async () => {
          const { key, plannedMimeType } = await this.storage.planUpload(
            orgId,
            body,
            folder,
            originalName,
            originalMimeType,
          );
          const sha256 = createHash("sha256").update(body).digest("hex");

          const quarantineId = await this.quarantine.begin({
            orgId,
            storageKey: key,
            filename: originalName,
            mimeType: plannedMimeType,
            fileSizeBytes: fileSize,
            sha256,
            uploadedBy: userId,
          });

          return { key, plannedMimeType, quarantineId, declaredSha256: sha256 };
        },
        { orgId },
      );

    const enqueue = async (): Promise<void> => {
      const accepted = this.transforms.submit({
        name: "storage.upload.compress",
        orgId,
        run: () =>
          runOutsideTenantContext(() =>
            this.publishUpload({ orgId, userId, quarantineId, key, body, originalName, originalMimeType }),
          ),
        compensate: () =>
          runOutsideTenantContext(() => this.retractUpload(orgId, quarantineId, key)),
      });
      if (!accepted)
        await runOutsideTenantContext(() =>
          this.retractUpload(orgId, quarantineId, key),
        ).catch((error: unknown) => {
          this.logger.error("Upload retraction failed after a refused transform", {
            orgId,
            quarantineId,
            reason: error instanceof Error ? error.message : String(error),
          });
        });
    };

    await enqueue();

    return {
      quarantineId,
      status: "pending_scan",
      key,
      mimeType: plannedMimeType,
      size: fileSize,
      sha256: declaredSha256,
    };
  }

  /**
   * Compresses, puts the object down, records what the object actually holds,
   * then releases it from quarantine. The order is the point: nothing is
   * reachable until the row that gates it says clean, and the measured size and
   * type replace the planned ones so the quota is accounted on the bytes that
   * were stored rather than the bytes that arrived.
   *
   * The release opens its OWN tenant transaction and the object write stays
   * outside it. This runs on the transform runner, after the request that
   * submitted it has committed and returned, so the ambient handle is dead and
   * `file_quarantine_records` carries an RLS policy that fails closed without
   * the GUC — a release written on the request's context never lands, leaving a
   * scanned, stored object blocked forever. Holding the transaction across
   * `compressToKey` would be the opposite mistake: a pooled connection pinned
   * for the length of an object-store outage.
   */
  private async publishUpload(job: {
    orgId: string;
    userId: string;
    quarantineId: string;
    key: string;
    body: Buffer;
    originalName: string;
    originalMimeType: string;
  }): Promise<void> {
    const stored = await this.storage.compressToKey(
      job.orgId,
      job.body,
      job.key,
      job.originalName,
      job.originalMimeType,
    );

    await runInNewTenantTransaction(this.db, job.orgId, async () => {
      await this.quarantine.recordMeasuredObject(job.quarantineId, {
        fileSizeBytes: stored.size,
        mimeType: stored.mimeType,
      });
      await this.quarantine.markClean(job.quarantineId);
    });

    this.audit.log({
      action: "file.upload",
      userId: job.userId,
      orgId: job.orgId,
      metadata: { fileKey: job.key, fileSize: stored.size, mimeType: stored.mimeType },
    });
  }

  /**
   * The object goes first. `isKeyBlocked` ignores a soft-deleted row, so
   * dropping the row before the bytes are gone would publish exactly the
   * half-written file this path exists to retract. Each row write opens its own
   * tenant transaction for the same reason `publishUpload` does, and the two
   * stay separate so the object delete never runs inside one.
   */
  private async retractUpload(
    orgId: string,
    quarantineId: string,
    key: string,
  ): Promise<void> {
    await runInNewTenantTransaction(this.db, orgId, () =>
      this.quarantine.markError(quarantineId),
    );
    await this.storage.deleteFileIfPresent(orgId, key).catch(() => false);
    await runInNewTenantTransaction(this.db, orgId, () =>
      this.quarantine.softDelete(quarantineId),
    );
  }

  @Get("download")
  @AuthorizedInService("assertKeyReadable")
  @ApiOkResponse({ schema: { type: "string", format: "binary" }, description: "Binary file stream (attachment=1) or JSON { url } signed-URL redirect" })
  @Validate({ query: downloadQuerySchema })
  async download(
    @Query() queryParams: DownloadQueryInput,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ): Promise<void> {
    if (!this.storage.isConfigured()) {
      throw new ServiceUnavailableException("Cloud storage not configured");
    }

    const { url: urlParam, key: keyParam, expiresIn, attachment: attachmentParam } = queryParams;
    const attachment = attachmentParam === "1";

    const fileKey = keyParam || (urlParam ? this.storage.getFileKeyFromUrl(urlParam) : "");
    if (!fileKey || !this.storage.isValidFileKey(fileKey)) {
      throw new BadRequestException("Invalid file reference");
    }

    const orgId = u.orgId;

    await assertKeyReadable(this.db, this.quarantine, fileKey, orgId, "File not found");

    this.audit.log({ action: "file.download", userId: u.userId, orgId, metadata: { fileKey } });

    if (attachment) {
      const stream = await this.openStream(orgId, fileKey, "File not found");
      const filename = this.storage.getFileNameFromKey(fileKey);
      res.setHeader("Content-Type", stream.contentType || this.storage.getMimeType(fileKey));
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename.replace(/"/g, "%22")}"`,
      );
      this.pipe(stream.body, res);
      return;
    }

    const signedUrl = await this.storage.getFileUrl(orgId, fileKey, expiresIn, undefined, {
      preauthorized: true,
    });
    res.json({ url: signedUrl });
  }

  @Get("image")
  @AuthorizedInService("assertKeyReadable")
  @ApiOkResponse({ schema: { type: "string", format: "binary" }, description: "Binary image stream" })
  @Validate({ query: imageQuerySchema })
  async image(
    @Query() queryParams: ImageQueryInput,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ): Promise<void> {
    const keyParam = queryParams.key;
    if (!this.storage.isValidFileKey(keyParam)) {
      throw new BadRequestException("Invalid key parameter");
    }
    if (!this.storage.isConfigured()) {
      throw new ServiceUnavailableException("Storage not available");
    }

    await assertKeyReadable(this.db, this.quarantine, keyParam, u.orgId, "Not found");

    const stream = await this.openStream(u.orgId, keyParam, "Not found");
    res.setHeader("Content-Type", stream.contentType || this.storage.getMimeType(keyParam));
    /**
     * `immutable` told the browser not to revalidate for a day, which outlives
     * both a replacement of the object under the same key and a revocation of
     * the permission that `assertKeyReadable` just checked — the revoked viewer
     * keeps serving the image from its own cache and no further request reaches
     * this handler. `Vary` is the companion: the bearer token is the only thing
     * separating two viewers of the same URL.
     */
    res.setHeader("Cache-Control", "private, max-age=60, must-revalidate");
    res.setHeader("Vary", "Authorization, Cookie");
    this.pipe(stream.body, res);
  }

  private async assertUploadAllowed(
    folder: string,
    user: CurrentUserContext,
  ): Promise<void> {
    const required = GENERIC_SENSITIVE_UPLOAD_PERMISSIONS[folder];
    const folderRoot = folder.split("/", 1)[0] ?? folder;
    if (!isSensitiveFolderRoot(folderRoot)) return;
    if (user.isOrgOwner && required) return;
    if (!required) throw new ForbiddenException("Use the feature-specific upload endpoint");

    const permissions = await this.access.resolveUserPermissions(
      user.orgId,
      user.userId,
    );
    if (!required.some((permission) => permissions.has(permission))) {
      throw new ForbiddenException("Access denied");
    }
  }

  private async openStream(
    orgId: string,
    key: string,
    notFoundMessage: string,
  ): Promise<FileStreamResult> {
    try {
      return await this.storage.getFileStream(orgId, key);
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
