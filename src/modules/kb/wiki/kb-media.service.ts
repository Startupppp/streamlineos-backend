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

    await this.recordAttachment(u, pageId ?? null, originalname, result, kbBucket);

    this.audit.log({
      action: "kb.media_upload",
      userId: u.userId,
      orgId: u.orgId,
      metadata: { fileKey: result.key, size: result.size, mimeType: result.mimeType },
    });

    if (pageId != null && DOC_TYPES.has(mimetype)) {
      const indexPageId = pageId;
      const index = () =>
        this.attachmentIndexing.indexPageDocument(u.orgId, indexPageId, buffer, mimetype, originalname);
      /**
       * This was a bare `void`-with-`.catch` fire-and-forget, and it never
       * indexed anything. The promise inherits the request's AsyncLocalStorage
       * context, so `this.db` resolved to the request transaction — but the
       * handler had already returned and that transaction had COMMITTED by the
       * time the extract and the embedding round trip finished, so
       * `indexPageDocument`'s own `db.transaction(...)` ran on a dead handle.
       * The `.catch` then swallowed the failure into a log line, which is why
       * page-document uploads reported success and were never searchable.
       *
       * `registerAfterCommit` is the right mechanism here (backend/CLAUDE.md 4,
       * case 3): the attachment row is already committed and carries the file
       * key, so a crash before indexing is re-drivable from stored state. The
       * interceptor drains each hook inside its own
       * `runInNewTenantTransaction`, so the GUC is present. It returns false
       * when there is no ambient context, in which case the work runs inline
       * rather than being dropped, and the hook deliberately does NOT swallow —
       * the drain reports a rejection, and a silent indexing failure is what
       * hid this for so long.
       */
      const deferred = registerAfterCommit(async () => {
        await index();
      });
      if (!deferred) {
        await index().catch((err: unknown) => {
          this.logger.error(`Failed to index page document (page ${indexPageId}): ${String(err)}`);
        });
      }
    }

    return { ...result, name: originalname };
  }

  /**
   * The ledger row is the object's only pointer, so it is written under
   * compensation rather than after a bare `await`.
   *
   * A `kb-media` key resolves to its organisation off the key alone
   * (`ORG_NAMESPACED_KEY_FOLDERS`, `storage-key.ts`), so `assertKeyReadable`
   * never consults this table and an object with no row stays readable by the
   * whole tenant. Nothing collects it either: both KB purge paths enumerate
   * `kb_page_attachments` (`kb-page-attachment-purge.ts`) and the storage sweep
   * works from the rows they register, so no sweep lists the bucket. The bytes
   * are therefore removed before the failure propagates, carrying the same
   * bucket override the upload used — an S3 delete addressed at the wrong bucket
   * answers success while the object survives.
   */
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
