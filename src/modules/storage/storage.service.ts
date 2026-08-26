import { Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { randomUUID } from "crypto";
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
import { APP_CONFIG } from "../../config/config.module";
import type { AppConfig } from "../../config/env.validation";
import { getRegionRegistry, hasRegionRegistry } from "../../common/region/region-registry";
import type { RegionStorageConfig } from "../../common/region/region.config";

interface R2Config {
  region: string;
  bucketName: string | undefined;
  accessKeyId: string | undefined;
  secretAccessKey: string | undefined;
  endpoint: string | undefined;
}

export interface UploadResult {
  url: string;
  key: string;
  size: number;
  mimeType: string;
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
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

const PRIVATE_HR_FOLDERS = new Set([
  "documents",
  "hr-documents",
  "onboarding",
  "onboarding-docs",
  "resignations",
  "hr-exports",
]);

/**
 * Only the object-storage settings this service reads. The full `AppConfig` is
 * still what gets injected — it satisfies this structurally — but stating the
 * six fields keeps the constructor honest and lets a test supply them without
 * standing up every unrelated environment variable.
 */
export type StorageConfig = Pick<
  AppConfig,
  | "R2_REGION"
  | "R2_BUCKET_NAME"
  | "R2_ACCESS_KEY_ID"
  | "R2_SECRET_ACCESS_KEY"
  | "R2_ENDPOINT"
  | "NEXT_PUBLIC_R2_PUBLIC_URL"
>;

@Injectable()
export class StorageService {
  private readonly client: S3Client;

  constructor(
    private readonly compression: MediaCompressionService,
    @Inject(APP_CONFIG) private readonly config: StorageConfig,
  ) {
    const cfg = this.getConfig();
    this.client = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint,
      credentials:
        cfg.accessKeyId && cfg.secretAccessKey
          ? { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey }
          : undefined,
      requestHandler: {
        connectionTimeout: 5_000,
        requestTimeout: 120_000,
        throwOnRequestTimeout: true,
      },
    });
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
    return StorageService.toR2Config(await getRegionRegistry().storageForOrg(orgId));
  }

  isConfigured(): boolean {
    const config = this.getConfig();
    return Boolean(
      config.bucketName && config.accessKeyId && config.secretAccessKey && config.endpoint,
    );
  }

  private requireBucket(): string {
    const { bucketName } = this.getConfig();
    if (!bucketName) throw new ServiceUnavailableException("R2 bucket not configured");
    return bucketName;
  }

  private resolveBucket(override?: string): string {
    const bucket = override || this.getConfig().bucketName;
    if (!bucket) throw new ServiceUnavailableException("R2 bucket not configured");
    return bucket;
  }

  private publicUrlFor(folder: string, key: string, override?: string): string {
    const folderRoot = folder.split("/", 1)[0] ?? folder;
    if (PRIVATE_HR_FOLDERS.has(folderRoot)) return key;
    const publicBase = override ?? this.config.NEXT_PUBLIC_R2_PUBLIC_URL;
    return publicBase ? `${publicBase}/${key}` : key;
  }

  async uploadFile(
    buffer: Buffer,
    folder = "uploads",
    fileName = "file",
    mimeType = "application/octet-stream",
    bucketOverride?: string,
    publicUrlOverride?: string,
  ): Promise<UploadResult> {
    const bucketName = this.resolveBucket(bucketOverride);

    const sanitizedName = fileName.replace(/[^a-zA-Z0-9.-]/g, "-");
    const key = `${folder}/${randomUUID()}-${sanitizedName}`;

    await this.client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: buffer,
        ContentType: mimeType,
      }),
    );

    return {
      url: this.publicUrlFor(folder, key, publicUrlOverride),
      key,
      size: buffer.length,
      mimeType,
    };
  }

  async uploadFileStream(
    body: Readable,
    contentLength: number,
    folder = "uploads",
    fileName = "file",
    mimeType = "application/octet-stream",
    bucketOverride?: string,
    publicUrlOverride?: string,
  ): Promise<UploadResult> {
    const bucketName = this.resolveBucket(bucketOverride);
    const sanitizedName = fileName.replace(/[^a-zA-Z0-9.-]/g, "-");
    const key = `${folder}/${randomUUID()}-${sanitizedName}`;

    await this.client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: body,
        ContentLength: contentLength,
        ContentType: mimeType,
      }),
    );

    return {
      url: this.publicUrlFor(folder, key, publicUrlOverride),
      key,
      size: contentLength,
      mimeType,
    };
  }

  async uploadCompressed(
    buffer: Buffer,
    folder = "uploads",
    fileName = "file",
    mimeType = "application/octet-stream",
    bucketOverride?: string,
    publicUrlOverride?: string,
  ): Promise<UploadResult> {
    const compressed = await this.compression.compress(buffer, mimeType, fileName);
    return this.uploadFile(
      compressed.buffer,
      folder,
      compressed.fileName,
      compressed.mimeType,
      bucketOverride,
      publicUrlOverride,
    );
  }

  async compressAndPreGenerateKey(
    buffer: Buffer,
    folder: string,
    fileName: string,
    mimeType: string,
    publicUrlOverride?: string,
  ): Promise<{ key: string; url: string; compressedBuffer: Buffer; compressedMimeType: string; size: number }> {
    const compressed = await this.compression.compress(buffer, mimeType, fileName);
    const sanitizedName = compressed.fileName.replace(/[^a-zA-Z0-9.-]/g, "-");
    const key = `${folder}/${randomUUID()}-${sanitizedName}`;
    const url = this.publicUrlFor(folder, key, publicUrlOverride);
    return {
      key,
      url,
      compressedBuffer: compressed.buffer,
      compressedMimeType: compressed.mimeType,
      size: compressed.buffer.length,
    };
  }

  async uploadToKey(
    buffer: Buffer,
    key: string,
    mimeType: string,
    bucketOverride?: string,
  ): Promise<void> {
    const bucketName = this.resolveBucket(bucketOverride);
    await this.client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: buffer,
        ContentType: mimeType,
      }),
    );
  }

  async getFileUrl(key: string, expiresIn = 3600): Promise<string> {
    const bucketName = this.requireBucket();
    const command = new GetObjectCommand({ Bucket: bucketName, Key: key });
    return getSignedUrl(this.client, command, { expiresIn });
  }

  async deleteFile(key: string): Promise<void> {
    const bucketName = this.requireBucket();
    await this.client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: key }));
  }

  async fileExists(key: string): Promise<boolean> {
    const { bucketName } = this.getConfig();
    if (!bucketName) return false;
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: bucketName, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  async getFileStream(key: string): Promise<FileStreamResult> {
    const bucketName = this.requireBucket();
    const response = await this.client.send(
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
      return decodeURIComponent(value.slice(base.length + 1).split(/[?#]/, 1)[0] ?? "");
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
    return MIME_MAP[extname(filePath).toLowerCase()] || "application/octet-stream";
  }

  isValidFileKey(key: string): boolean {
    if (!key || key.length > 1024) return false;
    if (key.includes("..") || key.includes("\\") || key.startsWith("/")) return false;
    if (key.includes("\0")) return false;
    if (/^[a-z][a-z0-9+.-]*:/i.test(key) || key.includes("?") || key.includes("#")) return false;
    return /^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(key);
  }
}
