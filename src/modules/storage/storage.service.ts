import {
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomUUID } from "crypto";
import { Readable } from "stream";
import { extname } from "path";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { MediaCompressionService } from "../../common/media/media-compression.service";
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
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export const DELETE_BATCH_LIMIT = 1_000;

export interface PurgeOrgPrefixResult {
  deleted: string[];
  skipped: string[];
  failed: Array<{ key: string; reason: string }>;
}

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

/** A resolved region: where the bytes go, and the client that can reach them. */
interface StoragePlacement {
  readonly client: S3Client;
  readonly bucketName?: string;
  readonly publicUrl?: string;
  readonly keyPrefix?: string;
}

@Injectable()
export class StorageService {
  /**
   * One client per region, not one client per service.
   *
   * The constructor used to build a single `S3Client` from the primary region's
   * endpoint and credentials. That made the region seam decorative: a call for a
   * US organisation resolved the US bucket name and then sent it to the EU
   * endpoint, because the client had been decided before anyone asked whose file
   * it was. Cached by endpoint and key rather than rebuilt per call — an
   * S3Client holds a connection pool, and one per upload would be a socket leak
   * wearing a region's name.
   */
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

  /**
   * Where this organisation's files live.
   *
   * With a registry installed this resolves through the *same* placement lookup
   * the database uses, so a tenant's rows and its documents cannot end up in
   * different regions. Without one — a single-region deployment — it is the
   * injected configuration, unchanged, so the existing behaviour and the
   * existing pool are exactly what they were.
   *
   * It does not fall back. An organisation nobody placed, or one placed in a
   * region this deployment does not serve, raises from `storageForOrg` and the
   * operation never runs. A silent fallback to the primary bucket is how one
   * tenant's documents are written into another region, and there is no undo.
   */
  private async placementFor(orgId: string): Promise<StoragePlacement> {
    if (!hasRegionRegistry()) {
      const cfg = this.getConfig();
      return {
        client: this.clientFor(cfg),
        bucketName: cfg.bucketName,
        publicUrl: this.config.NEXT_PUBLIC_R2_PUBLIC_URL,
      };
    }

    const storage = await getRegionRegistry().storageForOrg(orgId);
    const cfg = StorageService.toR2Config(storage);
    return {
      client: this.clientFor(cfg),
      bucketName: cfg.bucketName,
      publicUrl: storage.publicUrl ?? this.config.NEXT_PUBLIC_R2_PUBLIC_URL,
      keyPrefix: storage.keyPrefix,
    };
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

  /**
   * The bucket for a resolved placement.
   *
   * Replaces `requireBucket`/`resolveBucket`, which both read the *primary*
   * region's configuration regardless of whose file it was — the same mistake
   * as the shared client, one layer down.
   */
  private requireBucketFrom(
    placement: StoragePlacement,
    override?: string,
  ): string {
    const bucket = override || placement.bucketName;
    if (!bucket)
      throw new ServiceUnavailableException("R2 bucket not configured");
    return bucket;
  }

  private publicUrlFor(
    folder: string,
    key: string,
    regionPublicUrl: string | undefined,
    override?: string,
  ): string {
    const folderRoot = folder.split("/", 1)[0] ?? folder;
    if (PRIVATE_HR_FOLDERS.has(folderRoot)) return key;
    const publicBase = override ?? regionPublicUrl;
    return publicBase ? `${publicBase}/${key}` : key;
  }

  async uploadFile(
    orgId: string,
    buffer: Buffer,
    folder = "uploads",
    fileName = "file",
    mimeType = "application/octet-stream",
    bucketOverride?: string,
    publicUrlOverride?: string,
  ): Promise<UploadResult> {
    const placement = await this.placementFor(orgId);
    const bucketName = this.requireBucketFrom(placement, bucketOverride);

    const sanitizedName = fileName.replace(/[^a-zA-Z0-9.-]/g, "-");
    const rawKey = `${folder}/${randomUUID()}-${sanitizedName}`;
    const key = placement.keyPrefix
      ? `${placement.keyPrefix}/${rawKey}`
      : rawKey;

    await placement.client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: buffer,
        ContentType: mimeType,
      }),
    );

    return {
      url: this.publicUrlFor(
        folder,
        key,
        placement.publicUrl,
        publicUrlOverride,
      ),
      key,
      size: buffer.length,
      mimeType,
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
    publicUrlOverride?: string,
  ): Promise<UploadResult> {
    const placement = await this.placementFor(orgId);
    const bucketName = this.requireBucketFrom(placement, bucketOverride);
    const sanitizedName = fileName.replace(/[^a-zA-Z0-9.-]/g, "-");
    const rawKey = `${folder}/${randomUUID()}-${sanitizedName}`;
    const key = placement.keyPrefix
      ? `${placement.keyPrefix}/${rawKey}`
      : rawKey;

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
      url: this.publicUrlFor(
        folder,
        key,
        placement.publicUrl,
        publicUrlOverride,
      ),
      key,
      size: contentLength,
      mimeType,
    };
  }

  async uploadCompressed(
    orgId: string,
    buffer: Buffer,
    folder = "uploads",
    fileName = "file",
    mimeType = "application/octet-stream",
    bucketOverride?: string,
    publicUrlOverride?: string,
  ): Promise<UploadResult> {
    const compressed = await this.compression.compress(
      buffer,
      mimeType,
      fileName,
    );
    return this.uploadFile(
      orgId,
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
  ): Promise<{
    key: string;
    url: string;
    compressedBuffer: Buffer;
    compressedMimeType: string;
    size: number;
  }> {
    const compressed = await this.compression.compress(
      buffer,
      mimeType,
      fileName,
    );
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
    orgId: string,
    buffer: Buffer,
    key: string,
    mimeType: string,
    bucketOverride?: string,
  ): Promise<void> {
    const placement = await this.placementFor(orgId);
    const bucketName = this.requireBucketFrom(placement, bucketOverride);
    const resolvedKey = placement.keyPrefix
      ? `${placement.keyPrefix}/${key}`
      : key;
    await placement.client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: resolvedKey,
        Body: buffer,
        ContentType: mimeType,
      }),
    );
  }

  /**
   * A signed URL is signed against one region's endpoint.
   *
   * Minted from the primary while the object sits in the tenant's own bucket,
   * it is a link that 404s for every organisation not placed there — so the
   * organisation is a parameter here exactly as it is for the write.
   */
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

  async fileExists(orgId: string, key: string): Promise<boolean> {
    const placement = await this.placementFor(orgId);
    const bucketName = placement.bucketName;
    if (!bucketName) return false;
    try {
      await placement.client.send(
        new HeadObjectCommand({ Bucket: bucketName, Key: key }),
      );
      return true;
    } catch {
      return false;
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

  async purgeOrgPrefix(orgId: string): Promise<PurgeOrgPrefixResult> {
    const placement = await this.placementFor(orgId);
    const bucketName = this.requireBucketFrom(placement);
    const rawPrefix = placement.keyPrefix?.replace(/\/$/, "");
    const prefix = rawPrefix ? `${rawPrefix}/` : undefined;

    const allKeys: string[] = [];
    let continuationToken: string | undefined;

    do {
      const res = await placement.client.send(
        new ListObjectsV2Command({
          Bucket: bucketName,
          Prefix: prefix,
          MaxKeys: DELETE_BATCH_LIMIT,
          ContinuationToken: continuationToken,
        }),
      );
      for (const obj of res.Contents ?? []) {
        if (typeof obj.Key === "string" && obj.Key.length > 0)
          allKeys.push(obj.Key);
      }
      continuationToken = res.IsTruncated
        ? res.NextContinuationToken
        : undefined;
    } while (continuationToken !== undefined);

    const deleted: string[] = [];
    const failed: Array<{ key: string; reason: string }> = [];

    for (let i = 0; i < allKeys.length; i += DELETE_BATCH_LIMIT) {
      const batch = allKeys.slice(i, i + DELETE_BATCH_LIMIT);
      try {
        const res = await placement.client.send(
          new DeleteObjectsCommand({
            Bucket: bucketName,
            Delete: {
              Objects: batch.map((k) => ({ Key: k })),
              Quiet: false,
            },
          }),
        );
        for (const del of res.Deleted ?? []) {
          if (typeof del.Key === "string") deleted.push(del.Key);
        }
        for (const err of res.Errors ?? []) {
          if (typeof err.Key === "string") {
            failed.push({
              key: err.Key,
              reason: err.Message ?? err.Code ?? "unknown",
            });
          }
        }
      } catch (err) {
        for (const key of batch) {
          failed.push({
            key,
            reason: err instanceof Error ? err.message : "unknown",
          });
        }
      }
    }

    return { deleted, skipped: [], failed };
  }
}
