import {
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createHash } from "crypto";
import { Readable } from "stream";
import { extname } from "path";
import {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { MediaCompressionService } from "../../common/media/media-compression.service";
import { APP_CONFIG } from "../../config/config.module";
import {
  StoragePlacementResolver,
  type R2Config,
  type StorageConfig,
  type StoragePlacement,
} from "./storage-placement";

export type { R2Config, StorageConfig, StoragePlacement };

export interface UploadResult {
  key: string;
  size: number;
  mimeType: string;
  sha256: string;
}

export interface UploadJobResult {
  quarantineId: string;
  status: "pending_scan";
  key: string;
  mimeType: string;
  size: number;
  sha256: string;
}

export interface FileStreamResult {
  body: Readable;
  contentType: string;
  contentLength: number | undefined;
}

const MIME_MAP: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export function isMissingObjectError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const details = error as Error & {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return details.name === "NotFound" || details.name === "NoSuchKey" || details.$metadata?.httpStatusCode === 404;
}

@Injectable()
export class StorageService {
  private readonly placement: StoragePlacementResolver;

  constructor(
    private readonly compression: MediaCompressionService,
    @Inject(APP_CONFIG) private readonly config: StorageConfig,
  ) {
    this.placement = new StoragePlacementResolver(config);
  }

  async placementForOrg(orgId: string): Promise<StoragePlacement> {
    return this.placement.forOrg(orgId);
  }

  async configForOrg(orgId: string): Promise<R2Config> {
    return this.placement.configForOrg(orgId);
  }

  isConfigured(): boolean {
    return this.placement.isConfigured();
  }

  async uploadFile(
    orgId: string,
    buffer: Buffer,
    folder = "uploads",
    fileName = "file",
    mimeType = "application/octet-stream",
    bucketOverride?: string,
  ): Promise<UploadResult> {
    const placement = await this.placement.forOrg(orgId);
    const bucketName = this.placement.requireBucket(placement, bucketOverride);
    const key = this.placement.objectKey(placement, orgId, folder, fileName);

    await placement.client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: buffer,
        ContentType: mimeType,
      }),
    );

    return {
      key,
      size: buffer.length,
      mimeType,
      sha256: createHash("sha256").update(buffer).digest("hex"),
    };
  }

  async uploadFileStream(
    orgId: string,
    body: Readable,
    contentLength: number,
    folder = "uploads",
    fileName = "file",
    mimeType = "application/octet-stream",
    bucketOverride?: string,
    sha256 = "",
  ): Promise<UploadResult> {
    const placement = await this.placement.forOrg(orgId);
    const bucketName = this.placement.requireBucket(placement, bucketOverride);
    const key = this.placement.objectKey(placement, orgId, folder, fileName);

    await placement.client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: body,
        ContentLength: contentLength,
        ContentType: mimeType,
      }),
    );

    return {
      key,
      size: contentLength,
      mimeType,
      sha256,
    };
  }

  /**
   * Chooses the object key without doing any transform work.
   *
   * Compression decides the stored format, and the format decides the key's
   * extension — but the key has to be in the response while the compression
   * runs off the request thread. `planOutput` separates the format decision
   * (cheap, header-only) from the encoding (expensive), so the key can be
   * settled now and the bytes written later.
   */
  async planUpload(
    orgId: string,
    buffer: Buffer,
    folder: string,
    fileName: string,
    mimeType: string,
  ): Promise<{ key: string; plannedMimeType: string }> {
    const planned = this.compression.planOutput(buffer, mimeType, fileName);
    const placement = await this.placement.forOrg(orgId);
    return {
      key: this.placement.objectKey(placement, orgId, folder, planned.fileName),
      plannedMimeType: planned.mimeType,
    };
  }

  /**
   * The deferred half of an upload: compress, then write to the key the request
   * already handed out. Returns what the object actually holds, which may
   * differ from the plan when a transform declines or fails — the caller
   * records the measured values, and every read serves the type the store
   * reports rather than the one the key spells.
   */
  async compressToKey(
    orgId: string,
    buffer: Buffer,
    key: string,
    fileName: string,
    mimeType: string,
  ): Promise<{ size: number; mimeType: string; sha256: string }> {
    const compressed = await this.compression.compress(buffer, mimeType, fileName);
    await this.uploadToKey(orgId, compressed.buffer, key, compressed.mimeType);
    return {
      size: compressed.buffer.length,
      mimeType: compressed.mimeType,
      sha256: createHash("sha256").update(compressed.buffer).digest("hex"),
    };
  }

  /**
   * Writes to a key the caller already holds. The key is used verbatim: it came
   * from `planUpload`, which has already applied the region key prefix, and
   * prefixing again here would store the object somewhere no read path looks.
   */
  async uploadToKey(
    orgId: string,
    buffer: Buffer,
    key: string,
    mimeType: string,
    bucketOverride?: string,
  ): Promise<void> {
    const placement = await this.placement.forOrg(orgId);
    const bucketName = this.placement.requireBucket(placement, bucketOverride);
    await placement.client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: buffer,
        ContentType: mimeType,
      }),
    );
  }

  async getFileUrl(
    orgId: string,
    key: string,
    expiresIn = 3600,
  ): Promise<string> {
    const placement = await this.placement.forOrg(orgId);
    const bucketName = this.placement.requireBucket(placement);
    const command = new GetObjectCommand({ Bucket: bucketName, Key: key });
    return getSignedUrl(placement.client, command, { expiresIn });
  }

  async deleteFile(orgId: string, key: string): Promise<void> {
    const placement = await this.placement.forOrg(orgId);
    const bucketName = this.placement.requireBucket(placement);
    await placement.client.send(
      new DeleteObjectCommand({ Bucket: bucketName, Key: key }),
    );
  }

  /**
   * Cleanup path. A failed upload, a rejected transform and an aborted
   * multipart all have to remove the object, and none of them may fail because
   * the object was never written in the first place.
   */
  async deleteFileIfPresent(orgId: string, key: string): Promise<boolean> {
    try {
      await this.deleteFile(orgId, key);
      return true;
    } catch (error) {
      if (isMissingObjectError(error)) return false;
      throw error;
    }
  }

  async describeObject(
    orgId: string,
    key: string,
  ): Promise<{ contentLength: number; contentType: string } | null> {
    const placement = await this.placement.forOrg(orgId);
    const bucketName = this.placement.requireBucket(placement);
    try {
      const response = await placement.client.send(
        new HeadObjectCommand({ Bucket: bucketName, Key: key }),
      );
      return {
        contentLength: response.ContentLength ?? 0,
        contentType: response.ContentType ?? "application/octet-stream",
      };
    } catch (error) {
      if (isMissingObjectError(error)) return null;
      throw error;
    }
  }

  /**
   * Reads only the leading bytes, so a multipart object can be sniffed without
   * pulling a multi-gigabyte body back through the API.
   */
  async readObjectPrefix(
    orgId: string,
    key: string,
    byteCount: number,
  ): Promise<Buffer | null> {
    const placement = await this.placement.forOrg(orgId);
    const bucketName = this.placement.requireBucket(placement);
    try {
      const response = await placement.client.send(
        new GetObjectCommand({
          Bucket: bucketName,
          Key: key,
          Range: `bytes=0-${Math.max(byteCount - 1, 0)}`,
        }),
      );
      const body = response.Body;
      if (!body || !(body instanceof Readable)) return null;
      const chunks: Buffer[] = [];
      for await (const chunk of body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        if (Buffer.concat(chunks).length >= byteCount) break;
      }
      return Buffer.concat(chunks).subarray(0, byteCount);
    } catch (error) {
      if (isMissingObjectError(error)) return null;
      throw error;
    }
  }

  async fileExists(orgId: string, key: string): Promise<boolean> {
    const placement = await this.placement.forOrg(orgId);
    const bucketName = placement.bucketName;
    if (!bucketName) throw new ServiceUnavailableException("R2 bucket not configured");
    try {
      await placement.client.send(
        new HeadObjectCommand({ Bucket: bucketName, Key: key }),
      );
      return true;
    } catch (error) {
      if (isMissingObjectError(error)) return false;
      throw error;
    }
  }

  async getFileStream(orgId: string, key: string): Promise<FileStreamResult> {
    const placement = await this.placement.forOrg(orgId);
    const bucketName = this.placement.requireBucket(placement);
    const response = await placement.client.send(
      new GetObjectCommand({ Bucket: bucketName, Key: key }),
    );
    const body = response.Body;
    if (!body || !(body instanceof Readable)) {
      throw new NotFoundException("File not found or empty");
    }
    return {
      body,
      contentType: response.ContentType ?? "application/octet-stream",
      contentLength: response.ContentLength,
    };
  }

  getFileKeyFromUrl(url: string): string {
    const value = url.trim();
    if (!/^https?:\/\//i.test(value)) return value;

    const base = this.config.NEXT_PUBLIC_R2_PUBLIC_URL?.replace(/\/$/, "");
    if (!base || !value.startsWith(`${base}/`)) return "";

    try {
      return decodeURIComponent(
        value.slice(base.length + 1).split(/[?#]/, 1)[0] ?? "",
      );
    } catch {
      return "";
    }
  }

  getFileNameFromKey(key: string): string {
    const parts = key.split("/");
    const last = parts[parts.length - 1] ?? "download";
    const match = last.match(/^(?:\d+|[0-9a-f-]{36})-(.+)$/i);
    return match ? match[1] : last;
  }

  getMimeType(filePath: string): string {
    return (
      MIME_MAP[extname(filePath).toLowerCase()] || "application/octet-stream"
    );
  }

  isValidFileKey(key: string): boolean {
    if (!key || key.length > 1024) return false;
    if (key.includes("..") || key.includes("\\") || key.startsWith("/"))
      return false;
    if (key.includes("\0")) return false;
    if (
      /^[a-z][a-z0-9+.-]*:/i.test(key) ||
      key.includes("?") ||
      key.includes("#")
    )
      return false;
    return /^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(key);
  }
}
