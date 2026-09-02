import { BadRequestException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from "@nestjs/common";
import sharp from "sharp";
import { and, eq, isNull } from "drizzle-orm";
import { kbPageAttachments, kbPages } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { StorageService, type UploadResult } from "../../storage/storage.service";
import { validateMagicBytes } from "../../storage/file-signatures";
import { KbAttachmentIndexingService } from "../retrieval/kb-attachment-indexing.service";
import { APP_CONFIG } from "../../../config/config.module";
import type { AppConfig } from "../../../config/env.validation";
import { AvScanner } from "../../../common/security/av-scan";

export interface KbMediaUploadResult extends UploadResult {
  name: string;
}

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const VIDEO_TYPES = new Set(["video/mp4", "video/webm"]);
const AUDIO_TYPES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/ogg",
  "audio/mp4",
  "audio/x-m4a",
]);
const DOC_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-powerpoint",
  "text/csv",
  "text/plain",
  "application/zip",
]);

const ALLOWED_TYPES = new Set([...IMAGE_TYPES, ...VIDEO_TYPES, ...AUDIO_TYPES, ...DOC_TYPES]);

const IMAGE_CAP = 10 * 1024 * 1024;
const VIDEO_CAP = 100 * 1024 * 1024;
const AUDIO_CAP = 25 * 1024 * 1024;
const DOC_CAP = 25 * 1024 * 1024;

const COMPRESSIBLE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/**
 * A 10MB PNG can decode to tens of gigabytes. The byte cap above bounds what
 * arrives; this bounds what the decoder is allowed to allocate from it.
 */
const MAX_IMAGE_PIXELS = 50_000_000;

function sizeCap(mimeType: string): number {
  if (IMAGE_TYPES.has(mimeType)) return IMAGE_CAP;
  if (VIDEO_TYPES.has(mimeType)) return VIDEO_CAP;
  if (AUDIO_TYPES.has(mimeType)) return AUDIO_CAP;
  return DOC_CAP;
}

@Injectable()
export class KbMediaService {
  private readonly logger = new Logger(KbMediaService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly attachmentIndexing: KbAttachmentIndexingService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly avScanner: AvScanner,
  ) {}

  async upload(
    file: Express.Multer.File,
    u: CurrentUserContext,
    pageId?: number,
  ): Promise<KbMediaUploadResult> {
    if (!this.storage.isConfigured()) {
      throw new ServiceUnavailableException("File storage is not available");
    }

    if (pageId != null) await this.assertPageInOrg(u.orgId, pageId);

    const { mimetype, buffer, originalname } = file;

    if (!ALLOWED_TYPES.has(mimetype)) {
      throw new BadRequestException("File type not allowed");
    }

    if (buffer.length > sizeCap(mimetype)) {
      throw new BadRequestException("File exceeds the size limit for this type");
    }

    if (!validateMagicBytes(buffer, mimetype)) {
      throw new BadRequestException("File content does not match declared type");
    }

    const scanResult = await this.avScanner.scan(buffer, originalname, mimetype);
    if (scanResult.status === "infected")
      throw new UnprocessableEntityException(`Upload rejected: malware detected (${scanResult.threat})`);
    if (scanResult.status === "error")
      throw new ServiceUnavailableException("Malware scan unavailable — upload rejected");

    const folder = `kb-media/${u.orgId}`;
    let uploadBuffer = buffer;
    let uploadMime = mimetype;
    let uploadName = originalname;

    if (COMPRESSIBLE_TYPES.has(mimetype)) {
      try {
        uploadBuffer = await sharp(uploadBuffer, { limitInputPixels: MAX_IMAGE_PIXELS })
          .rotate()
          .resize({ width: 1920, withoutEnlargement: true })
          .webp({ quality: 82 })
          .toBuffer();
        uploadMime = "image/webp";
        uploadName = originalname.replace(/\.[^.]+$/, "") + ".webp";
      } catch {
        throw new BadRequestException("Invalid image file");
      }
    }

    const kbBucket = this.config.R2_KB_BUCKET_NAME;
    const result = await this.storage.uploadFile(
      u.orgId,
      uploadBuffer,
      folder,
      uploadName,
      uploadMime,
      kbBucket,
    );

    await this.db
      .insert(kbPageAttachments)
      .values({
        orgId: u.orgId,
        pageId: pageId ?? null,
        fileKey: result.key,
        fileName: originalname,
        mimeType: result.mimeType,
        fileSize: result.size,
        sha256: result.sha256,
        uploadedById: u.userId,
      })
      .onConflictDoNothing({ target: [kbPageAttachments.orgId, kbPageAttachments.fileKey] });

    this.audit.log({
      action: "kb.media_upload",
      userId: u.userId,
      orgId: u.orgId,
      metadata: { fileKey: result.key, size: result.size, mimeType: result.mimeType },
    });

    if (pageId != null && DOC_TYPES.has(mimetype)) {
      this.attachmentIndexing
        .indexPageDocument(u.orgId, pageId, buffer, mimetype, originalname)
        .catch((err: unknown) => {
          this.logger.error(`Failed to index page document (page ${pageId}): ${err}`);
        });
    }

    return { ...result, name: originalname };
  }

  /**
   * A page id arrives from the request body and nothing checked it. With the
   * attachment row's composite (org_id, page_id) foreign key another tenant's
   * page id would raise 23503 after the bytes were already in the bucket, so it
   * is resolved first -- and resolved to 404, never 403, because a 403 on
   * another org's id confirms the page exists.
   */
  private async assertPageInOrg(orgId: string, pageId: number): Promise<void> {
    const page = await this.db.query.kbPages.findFirst({
      where: and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId), isNull(kbPages.deletedAt)),
      columns: { id: true },
    });
    if (!page) throw new NotFoundException("Page not found");
  }
}
