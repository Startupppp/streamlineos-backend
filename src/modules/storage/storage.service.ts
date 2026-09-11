import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "crypto";
import { Readable } from "stream";
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
import {
  configForOrg,
  isConfigured,
  placementFor,
  publicUrlFor,
  requireBucketFrom,
  type R2Config,
  type StorageConfig,
  type StoragePlacement,
  type StoragePlacementDeps,
} from "./lib/storage-placement";
import {
  getFileKeyFromUrl,
  getFileNameFromKey,
  getMimeType,
  isValidFileKey,
} from "./lib/storage-keys";

/** Re-exported from `lib/storage-placement` so every existing importer is unchanged. */
export type { R2Config, StorageConfig, StoragePlacement } from "./lib/storage-placement";

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

@Injectable()
export class StorageService {
  private readonly clients = new Map<string, S3Client>();

  constructor(
    private readonly compression: MediaCompressionService,
    @Inject(APP_CONFIG) private readonly config: StorageConfig,
  ) {}

  /** Bound once so the placement helpers share this instance's client cache. */
  private get placementDeps(): StoragePlacementDeps {
    return { config: this.config, clients: this.clients };
  }

  async placementForOrg(orgId: string): Promise<StoragePlacement> {
    return placementFor(this.placementDeps, orgId);
  }

  async configForOrg(orgId: string): Promise<R2Config> {
    return configForOrg(orgId);
  }

  isConfigured(): boolean {
    return isConfigured(this.placementDeps);
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
    const placement = await placementFor(this.placementDeps, orgId);
    const bucketName = requireBucketFrom(placement, bucketOverride);

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
      url: publicUrlFor(
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
    const placement = await placementFor(this.placementDeps, orgId);
    const bucketName = requireBucketFrom(placement, bucketOverride);
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
      url: publicUrlFor(
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
    const url = publicUrlFor(folder, key, publicUrlOverride);
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
    const placement = await placementFor(this.placementDeps, orgId);
    const bucketName = requireBucketFrom(placement, bucketOverride);
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

  async getFileUrl(
    orgId: string,
    key: string,
    expiresIn = 3600,
  ): Promise<string> {
    const placement = await placementFor(this.placementDeps, orgId);
    const bucketName = requireBucketFrom(placement);
    const command = new GetObjectCommand({ Bucket: bucketName, Key: key });
    return getSignedUrl(placement.client, command, { expiresIn });
  }

  async deleteFile(orgId: string, key: string): Promise<void> {
    const placement = await placementFor(this.placementDeps, orgId);
    const bucketName = requireBucketFrom(placement);
    await placement.client.send(
      new DeleteObjectCommand({ Bucket: bucketName, Key: key }),
    );
  }

  async fileExists(orgId: string, key: string): Promise<boolean> {
    const placement = await placementFor(this.placementDeps, orgId);
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
    const placement = await placementFor(this.placementDeps, orgId);
    const bucketName = requireBucketFrom(placement);
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
    return getFileKeyFromUrl(url, this.config.NEXT_PUBLIC_R2_PUBLIC_URL);
  }

  getFileNameFromKey(key: string): string {
    return getFileNameFromKey(key);
  }

  getMimeType(filePath: string): string {
    return getMimeType(filePath);
  }

  isValidFileKey(key: string): boolean {
    return isValidFileKey(key);
  }
}
