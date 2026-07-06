import { Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
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

@Injectable()
export class StorageService {
  private getConfig(): R2Config {
    return {
      region: process.env.R2_REGION || "auto",
      bucketName: process.env.R2_BUCKET_NAME,
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      endpoint: process.env.R2_ENDPOINT,
    };
  }

  isConfigured(): boolean {
    const config = this.getConfig();
    return Boolean(
      config.bucketName && config.accessKeyId && config.secretAccessKey && config.endpoint,
    );
  }

  private getClient(): S3Client {
    const config = this.getConfig();
    return new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      credentials:
        config.accessKeyId && config.secretAccessKey
          ? { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }
          : undefined,
    });
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
    const key = `${folder}/${Date.now()}-${sanitizedName}`;

    await this.getClient().send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: buffer,
        ContentType: mimeType,
      }),
    );

    const publicBase = publicUrlOverride || process.env.NEXT_PUBLIC_R2_PUBLIC_URL;
    const publicUrl = publicBase ? `${publicBase}/${key}` : key;

    return { url: publicUrl, key, size: buffer.length, mimeType };
  }

  async getFileUrl(key: string, expiresIn = 3600): Promise<string> {
    const bucketName = this.requireBucket();
    const command = new GetObjectCommand({ Bucket: bucketName, Key: key });
    return getSignedUrl(this.getClient(), command, { expiresIn });
  }

  async deleteFile(key: string): Promise<void> {
    const bucketName = this.requireBucket();
    await this.getClient().send(new DeleteObjectCommand({ Bucket: bucketName, Key: key }));
  }

  async fileExists(key: string): Promise<boolean> {
    const { bucketName } = this.getConfig();
    if (!bucketName) return false;
    try {
      await this.getClient().send(new HeadObjectCommand({ Bucket: bucketName, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  async getFileStream(key: string): Promise<FileStreamResult> {
    const bucketName = this.requireBucket();
    const response = await this.getClient().send(
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
    const base = process.env.NEXT_PUBLIC_R2_PUBLIC_URL;
    return base ? url.replace(`${base}/`, "") : url;
  }

  getFileNameFromKey(key: string): string {
    const parts = key.split("/");
    const last = parts[parts.length - 1] ?? "download";
    const match = last.match(/^\d+-(.+)$/);
    return match ? match[1] : last;
  }

  getMimeType(filePath: string): string {
    return MIME_MAP[extname(filePath).toLowerCase()] || "application/octet-stream";
  }

  isValidFileKey(key: string): boolean {
    if (key.includes("..") || key.includes("\\") || key.startsWith("/")) return false;
    if (key.includes("\0")) return false;
    return true;
  }
}
