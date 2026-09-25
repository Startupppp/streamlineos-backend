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
import { registerAfterCommit } from "../../../common/tenant/tenant-context";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { APP_CONFIG } from "../../../config/config.module";
import type { AppConfig } from "../../../config/env.validation";
import { AvScanner } from "../../../common/security/av-scan";
import { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";

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

const MAX_IMAGE_PIXELS = 50_000_000;

const MAX_IMAGE_MEGAPIXELS = MAX_IMAGE_PIXELS / 1_000_000;

function imageTransformRefusal(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return reason.includes("pixel limit")
    ? `Image is larger than the ${MAX_IMAGE_MEGAPIXELS} megapixel processing limit`
    : "Invalid image file";
}

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
    private readonly auth: KnowledgeAuthorizationService,
  ) {}

  async upload(
    file: Express.Multer.File,
    u: CurrentUserContext,
    pageId?: number,
  ): Promise<KbMediaUploadResult> {
    if (!this.storage.isConfigured()) {
      throw new ServiceUnavailableException("File storage is not available");
    }

    if (pageId != null) {
      await runInTenantTransaction(
        this.db,
        async () => { await this.assertPageVisible(u, pageId); },
        { orgId: u.orgId },
      );
    }

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
      } catch (error) {
        this.logger.error(
          `KB image transform failed (${mimetype}, ${buffer.length} bytes, "${originalname}"): ${String(error)}`,
        );
        throw new BadRequestException(imageTransformRefusal(error));
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

    await runInTenantTransaction(
      this.db,
      async () => {
        await this.recordAttachment(u, pageId ?? null, originalname, result, kbBucket);

        if (pageId != null && DOC_TYPES.has(mimetype)) {
          const indexPageId = pageId;
          const index = () =>
            this.attachmentIndexing.indexPageDocument(u.orgId, indexPageId, buffer, mimetype, originalname);
          const deferred = registerAfterCommit(async () => {
            await index();
          });
          if (!deferred) {
            await index().catch((err: unknown) => {
              this.logger.error(`Failed to index page document (page ${indexPageId}): ${String(err)}`);
            });
          }
        }
      },
      { orgId: u.orgId },
    );

    this.audit.log({
      action: "kb.media_upload",
      userId: u.userId,
      orgId: u.orgId,
      metadata: { fileKey: result.key, size: result.size, mimeType: result.mimeType },
    });

    return { ...result, name: originalname };
  }

  private async recordAttachment(
    u: CurrentUserContext,
    pageId: number | null,
    fileName: string,
    result: UploadResult,
    kbBucket: string | undefined,
  ): Promise<void> {
    try {
      await this.db
        .insert(kbPageAttachments)
        .values({
          orgId: u.orgId,
          pageId,
          fileKey: result.key,
          fileName,
          mimeType: result.mimeType,
          fileSize: result.size,
          sha256: result.sha256,
          uploadedById: u.userId,
        })
        .onConflictDoNothing({ target: [kbPageAttachments.orgId, kbPageAttachments.fileKey] });
    } catch (error) {
      await this.storage
        .deleteFileIfPresent(u.orgId, result.key, kbBucket)
        .catch((cleanupError: unknown) => {
          this.logger.error(
            `Orphaned KB object ${result.key}: the attachment row failed and the object could not be removed (${String(cleanupError)})`,
          );
          return false;
        });
      throw error;
    }
  }

  private async assertPageVisible(user: CurrentUserContext, pageId: number): Promise<void> {
    const predicate = await this.auth.visiblePagePredicate(user, "view");
    const page = await this.db.query.kbPages.findFirst({
      where: and(eq(kbPages.id, pageId), eq(kbPages.orgId, user.orgId), isNull(kbPages.deletedAt), predicate),
      columns: { id: true },
    });
    if (!page) throw new NotFoundException("Page not found");
  }
}
