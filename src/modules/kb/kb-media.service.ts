import { BadRequestException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import sharp from "sharp";
import { AuditService } from "../../common/audit/audit.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { StorageService, type UploadResult } from "../storage/storage.service";
import { validateMagicBytes } from "../storage/file-signatures";

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

function sizeCap(mimeType: string): number {
  if (IMAGE_TYPES.has(mimeType)) return IMAGE_CAP;
  if (VIDEO_TYPES.has(mimeType)) return VIDEO_CAP;
  if (AUDIO_TYPES.has(mimeType)) return AUDIO_CAP;
  return DOC_CAP;
}

@Injectable()
export class KbMediaService {
  constructor(
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  async upload(file: Express.Multer.File, u: CurrentUserContext): Promise<KbMediaUploadResult> {
    if (!this.storage.isConfigured()) {
      throw new ServiceUnavailableException("File storage is not available");
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

    const folder = `kb-media/${u.orgId}`;
    let uploadBuffer = buffer;
    let uploadMime = mimetype;
    let uploadName = originalname;

    if (COMPRESSIBLE_TYPES.has(mimetype)) {
      try {
        uploadBuffer = await sharp(uploadBuffer)
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

    const result = await this.storage.uploadFile(uploadBuffer, folder, uploadName, uploadMime);

    this.audit.log({
      action: "kb.media_upload",
      userId: u.userId,
      orgId: u.orgId,
      metadata: { fileKey: result.key, size: result.size, mimeType: result.mimeType },
    });

    return { ...result, name: originalname };
  }
}
