import {
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createHash, randomUUID } from "crypto";
import { Readable } from "stream";
import { extname } from "path";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { MediaCompressionService } from "../../common/media/media-compression.service";
import { sanitizeFileName } from "./storage-key";
import { APP_CONFIG } from "../../config/config.module";
import type { AppConfig } from "../../config/env.validation";
import {
  getRegionRegistry,
  hasRegionRegistry,
} from "../../common/region/region-registry";
import type { RegionStorageConfig } from "../../common/region/region.config";

interface R2Config {
  region: string;
  bucketName: string | undefined;
  accessKeyId: string | undefined;
  secretAccessKey: string | undefined;
  endpoint: string | undefined;
}

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

export type StorageConfig = Pick<
  AppConfig,
  | "R2_REGION"
  | "R2_BUCKET_NAME"
  | "R2_ACCESS_KEY_ID"
  | "R2_SECRET_ACCESS_KEY"
  | "R2_ENDPOINT"
  | "NEXT_PUBLIC_R2_PUBLIC_URL"
>;

export interface StoragePlacement {
  readonly client: S3Client;
  readonly bucketName?: string;
  readonly keyPrefix?: string;
}

@Injectable()
export class StorageService {
  private readonly clients = new Map<string, S3Client>();

  constructor(
    private readonly compression: MediaCompressionService,
    @Inject(APP_CONFIG) private readonly config: StorageConfig,
  ) {}

  private clientFor(cfg: R2Config): S3Client {
    const cacheKey = `${cfg.region}|${cfg.endpoint ?? ""}|${cfg.accessKeyId ?? ""}`;
    const existing = this.clients.get(cacheKey);
    if (existing) return existing;

    const client = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint,
      credentials:
        cfg.accessKeyId && cfg.secretAccessKey
          ? {
              accessKeyId: cfg.accessKeyId,
              secretAccessKey: cfg.secretAccessKey,
            }
          : undefined,
      requestHandler: {
        connectionTimeout: 5_000,
        requestTimeout: 120_000,
        throwOnRequestTimeout: true,
      },
    });
    this.clients.set(cacheKey, client);
    return client;
  }

  private async placementFor(orgId: string): Promise<StoragePlacement> {
    if (!hasRegionRegistry()) {
      const cfg = this.getConfig();
      return {
        client: this.clientFor(cfg),
        bucketName: cfg.bucketName,
      };
    }

    const storage = await getRegionRegistry().storageForOrg(orgId);
    const cfg = StorageService.toR2Config(storage);
    return {
      client: this.clientFor(cfg),
      bucketName: cfg.bucketName,
      keyPrefix: storage.keyPrefix,
    };
  }

  async placementForOrg(orgId: string): Promise<StoragePlacement> {
    return this.placementFor(orgId);
  }

  private static toR2Config(storage: RegionStorageConfig): R2Config {
    return {
      region: storage.region,
      bucketName: storage.bucket,
      accessKeyId: storage.accessKeyId,
      secretAccessKey: storage.secretAccessKey,
      endpoint: storage.endpoint,
    };
  }

  private getConfig(): R2Config {
    if (hasRegionRegistry()) {
      const registry = getRegionRegistry();
      return StorageService.toR2Config(
        registry.bindingFor(registry.primary).definition.storage,
      );
    }

    return {
      region: this.config.R2_REGION ?? "auto",
      bucketName: this.config.R2_BUCKET_NAME,
      accessKeyId: this.config.R2_ACCESS_KEY_ID,
      secretAccessKey: this.config.R2_SECRET_ACCESS_KEY,
      endpoint: this.config.R2_ENDPOINT,
    };
  }

  async configForOrg(orgId: string): Promise<R2Config> {
    return StorageService.toR2Config(
      await getRegionRegistry().storageForOrg(orgId),
    );
  }

  isConfigured(): boolean {
    const config = this.getConfig();
    return Boolean(
      config.bucketName &&
      config.accessKeyId &&
      config.secretAccessKey &&
      config.endpoint,
    );
  }

  private requireBucketFrom(
    placement: StoragePlacement,
    override?: string,
  ): string {
    const bucket = override || placement.bucketName;
    if (!bucket)
      throw new ServiceUnavailableException("R2 bucket not configured");
    return bucket;
  }

  private static objectKey(
    placement: StoragePlacement,
    orgId: string,
    folder: string,
    fileName: string,
  ): string {
    const rawKey = `${orgId}/${folder}/${randomUUID()}-${sanitizeFileName(fileName)}`;
    return placement.keyPrefix ? `${placement.keyPrefix}/${rawKey}` : rawKey;
  }

  async uploadFile(
    orgId: string,
    buffer: Buffer,
    folder = "uploads",
    fileName = "file",
    mimeType = "application/octet-stream",
    bucketOverride?: string,
  ): Promise<UploadResult> {
    const placement = await this.placementFor(orgId);
    const bucketName = this.requireBucketFrom(placement, bucketOverride);
    const key = StorageService.objectKey(placement, orgId, folder, fileName);

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
    const placement = await this.placementFor(orgId);
    const bucketName = this.requireBucketFrom(placement, bucketOverride);
    const key = StorageService.objectKey(placement, orgId, folder, fileName);

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
    const placement = await this.placementFor(orgId);
    return {
      key: StorageService.objectKey(placement, orgId, folder, planned.fileName),
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
    const placement = await this.placementFor(orgId);
    const bucketName = this.requireBucketFrom(placement, bucketOverride);
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
    const placement = await this.placementFor(orgId);
    const bucketName = this.requireBucketFrom(placement);
    const command = new GetObjectCommand({ Bucket: bucketName, Key: key });
    return getSignedUrl(placement.client, command, { expiresIn });
  }

  async deleteFile(orgId: string, key: string): Promise<void> {
    const placement = await this.placementFor(orgId);
    const bucketName = this.requireBucketFrom(placement);
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
    const placement = await this.placementFor(orgId);
    const bucketName = this.requireBucketFrom(placement);
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
    const placement = await this.placementFor(orgId);
    const bucketName = this.requireBucketFrom(placement);
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
    const placement = await this.placementFor(orgId);
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
    const placement = await this.placementFor(orgId);
    const bucketName = this.requireBucketFrom(placement);
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
