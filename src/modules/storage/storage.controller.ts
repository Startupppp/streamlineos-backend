import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
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
  Logger,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { ilike } from "drizzle-orm";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { AuthorizedInService } from "../../common/auth/authorized-in-service.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { AuditService } from "../../common/audit/audit.service";
import { MultipartAction } from "../../common/openapi/zod-operation-contracts";
import { registerAfterCommit } from "../../common/tenant";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import {
  documents,
  onboardingDocuments,
  expenses,
  reimbursements,
  handbookVersions,
  payslipPublications,
  candidateDocumentsVault,
} from "../../db/schema";
import { StorageService, type FileStreamResult, type UploadJobResult } from "./storage.service";
import { validateMagicBytes } from "./file-signatures";
import {
  isForeignOrgKey,
  isSensitiveFolderRoot,
  ORG_NAMESPACED_KEY_FOLDERS,
  parseStorageKey,
  sanitizeFolder,
} from "./storage-key";
import { FileQuarantineService } from "./file-quarantine.service";
import { MediaCompressionService } from "../../common/media/media-compression.service";
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
const TRANSFORM_TIMEOUT_MS = 30_000;
const ORG_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;
const USER_QUOTA_BYTES = 500 * 1024 * 1024;

type FileOwner = {
  orgId: string;
  access: "GENERIC" | "HR_DOCUMENT" | "ONBOARDING_DOCUMENT" | "PAYSLIP" | "CANDIDATE_VAULT";
};

function requiresDedicatedAccess(owner: FileOwner): boolean {
  return owner.access !== "GENERIC";
}

async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`transform exceeded ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
    private readonly compression: MediaCompressionService,
  ) {}

  @Post("upload")
  @MultipartAction({ file: "file", fields: { folder: "string" } })
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
    await this.assertUploadAllowed(folder, u);

    if (file.size > MAX_UPLOAD_SIZE) throw new BadRequestException("File too large (max 10MB)");
    if (!ALLOWED_UPLOAD_TYPES.includes(file.mimetype))
      throw new BadRequestException("File type not allowed");
    if (!validateMagicBytes(file.buffer, file.mimetype))
      throw new BadRequestException("File content does not match declared type");

    const [orgUsed, userUsed] = await Promise.all([
      this.quarantine.getTotalUsageBytes(u.orgId),
      this.quarantine.getTotalUsageBytesForUser(u.orgId, u.userId),
    ]);
    if (orgUsed + file.size > ORG_QUOTA_BYTES)
      throw new PayloadTooLargeException("Organization storage quota exceeded");
    if (userUsed + file.size > USER_QUOTA_BYTES)
      throw new PayloadTooLargeException("User storage quota exceeded");

    const scanResult = await this.avScanner.scan(file.buffer, file.originalname, file.mimetype);
    if (scanResult.status === "infected")
      throw new UnprocessableEntityException(`Upload rejected: malware detected (${scanResult.threat})`);
    if (scanResult.status === "error")
      throw new ServiceUnavailableException("Malware scan unavailable — upload rejected");

    const preGen = await withDeadline(
      this.storage.compressAndPreGenerateKey(
        u.orgId,
        file.buffer,
        folder,
        file.originalname,
        file.mimetype,
      ),
      TRANSFORM_TIMEOUT_MS,
    ).catch(() => {
      throw new UnprocessableEntityException("File could not be processed");
    });

    const quarantineId = await this.quarantine.begin({
      orgId: u.orgId,
      storageKey: preGen.key,
      filename: file.originalname,
      mimeType: preGen.compressedMimeType,
      fileSizeBytes: preGen.size,
      sha256: preGen.sha256,
      uploadedBy: u.userId,
    });

    const { orgId, userId } = u;
    const { key, compressedBuffer, compressedMimeType, size, sha256 } = preGen;
    const originalMimeType = file.mimetype;

    const publish = () =>
      this.publishUpload({
        orgId,
        userId,
        quarantineId,
        key,
        body: compressedBuffer,
        mimeType: compressedMimeType,
        originalMimeType,
        size,
      });

    if (!registerAfterCommit(publish)) await publish();

    return {
      quarantineId,
      status: "pending_scan",
      key,
      mimeType: compressedMimeType,
      size,
      sha256,
    };
  }

  /**
   * Puts the object down, releases it from quarantine, then derives the
   * preview. The order is the point: nothing is reachable until the row that
   * gates it says clean, and a failure at any step removes both the row and the
   * object rather than leaving one without the other.
   */
  private async publishUpload(job: {
    orgId: string;
    userId: string;
    quarantineId: string;
    key: string;
    body: Buffer;
    mimeType: string;
    originalMimeType: string;
    size: number;
  }): Promise<void> {
    try {
      await this.storage.uploadToKey(job.orgId, job.body, job.key, job.mimeType);
    } catch (error) {
      await this.quarantine.markError(job.quarantineId);
      /**
       * The object goes first. `isKeyBlocked` ignores a soft-deleted row, so
       * dropping the row before the bytes are gone would publish exactly the
       * half-written file this path exists to retract.
       */
      await this.storage.deleteFileIfPresent(job.orgId, job.key).catch(() => false);
      await this.quarantine.softDelete(job.quarantineId);
      throw error;
    }

    await this.quarantine.markClean(job.quarantineId);

    this.audit.log({
      action: "file.upload",
      userId: job.userId,
      orgId: job.orgId,
      metadata: { fileKey: job.key, fileSize: job.size, mimeType: job.mimeType },
    });

    await this.deriveThumbnail(job.orgId, job.key, job.body, job.originalMimeType);
  }

  /**
   * A derived preview is best-effort by construction: the original is already
   * published, so a failed transform must clean up its own half-written object
   * and leave the upload standing rather than failing the whole job.
   */
  private async deriveThumbnail(
    orgId: string,
    key: string,
    body: Buffer,
    originalMimeType: string,
  ): Promise<void> {
    const thumbKey = `${key}-thumb.webp`;
    try {
      const thumbBuffer = await withDeadline(
        this.compression.generateThumbnail(body, originalMimeType),
        TRANSFORM_TIMEOUT_MS,
      );
      if (!thumbBuffer) return;
      await this.storage.uploadToKey(orgId, thumbBuffer, thumbKey, "image/webp");
    } catch (error) {
      await this.storage.deleteFileIfPresent(orgId, thumbKey).catch(() => false);
      this.logger.warn(
        `thumbnail transform failed: ${error instanceof Error ? error.message : String(error)}`,
        { key },
      );
    }
  }

  @Get("download")
  @AuthorizedInService("assertKeyReadable")
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

    await this.assertKeyReadable(fileKey, u, "File not found");

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

    const signedUrl = await this.storage.getFileUrl(orgId, fileKey, expiresIn);
    res.json({ url: signedUrl });
  }

  @Get("image")
  @AuthorizedInService("assertKeyReadable")
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

    await this.assertKeyReadable(keyParam, u, "Not found");

    const stream = await this.openStream(u.orgId, keyParam, "Not found");
    res.setHeader("Content-Type", stream.contentType || this.storage.getMimeType(keyParam));
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    this.pipe(stream.body, res);
  }

  /**
   * The single gate every read of a raw object key passes, and it runs on the
   * request that mints the signed URL rather than on the one that listed the
   * file — a permission revoked between the two has to bite.
   *
   * Order matters. The key is refused for naming a foreign organisation before
   * anything is looked up, because a key the client chose is an input, not a
   * fact; only then is ownership resolved from the tables, and only then is the
   * quarantine consulted, so an unscanned or infected object is unreachable on
   * both the signed-URL and the streamed path.
   */
  private async assertKeyReadable(
    fileKey: string,
    user: CurrentUserContext,
    notFoundMessage: string,
  ): Promise<void> {
    if (isForeignOrgKey(fileKey, user.orgId))
      throw new NotFoundException(notFoundMessage);

    const fileOwner = await this.resolveFileOwner(fileKey, user.orgId);
    if (fileOwner !== null) {
      if (fileOwner.orgId !== user.orgId)
        throw new NotFoundException(notFoundMessage);
      if (requiresDedicatedAccess(fileOwner))
        throw new ForbiddenException("Access denied");
    } else if (isSensitiveFolderRoot(parseStorageKey(fileKey, user.orgId).folderRoot)) {
      throw new NotFoundException(notFoundMessage);
    }

    if (await this.quarantine.isKeyBlocked(user.orgId, fileKey))
      throw new NotFoundException(notFoundMessage);
  }

  /**
   * Protected resource types are denied here even for the same tenant and must use
   * their permission- and record-scoped download endpoint. Omitting a table means a file cannot be proven to belong to any
   * org: callers treat an unresolved sensitive key as a denial, so a missing table locks its
   * own file type out rather than exposing it. Returns the owning orgId, or null if untracked.
   */
  private async resolveFileOwner(
    fileKey: string,
    callerOrgId: string,
  ): Promise<FileOwner | null> {
    const { ownerOrgId, folderRoot } = parseStorageKey(fileKey, callerOrgId);
    if (ownerOrgId !== null && ORG_NAMESPACED_KEY_FOLDERS.has(folderRoot))
      return { orgId: ownerOrgId, access: "GENERIC" };

    const like = `%${fileKey}%`;
    const [doc, onboardingDoc, expense, reimbursement, handbookVersion, payslip, vaultDoc] =
      await Promise.all([
        this.db.query.documents.findFirst({ where: ilike(documents.fileUrl, like) }),
        this.db.query.onboardingDocuments.findFirst({ where: ilike(onboardingDocuments.fileUrl, like) }),
        this.db.query.expenses.findFirst({ where: ilike(expenses.receiptUrl, like) }),
        this.db.query.reimbursements.findFirst({ where: ilike(reimbursements.receiptUrl, like) }),
        this.db.query.handbookVersions.findFirst({ where: ilike(handbookVersions.documentUrl, like) }),
        this.db.query.payslipPublications.findFirst({ where: ilike(payslipPublications.pdfUrl, like) }),
        this.db.query.candidateDocumentsVault.findFirst({
          where: ilike(candidateDocumentsVault.fileUrl, like),
        }),
      ]);
    if (doc) return { orgId: doc.orgId, access: "HR_DOCUMENT" };
    if (onboardingDoc) return { orgId: onboardingDoc.orgId, access: "ONBOARDING_DOCUMENT" };
    if (payslip) return { orgId: payslip.orgId, access: "PAYSLIP" };
    if (vaultDoc) return { orgId: vaultDoc.orgId, access: "CANDIDATE_VAULT" };
    const genericOrgId =
      expense?.orgId ?? reimbursement?.orgId ?? handbookVersion?.orgId ?? null;
    return genericOrgId ? { orgId: genericOrgId, access: "GENERIC" } : null;
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
