import { Injectable, Logger } from "@nestjs/common";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  ListMultipartUploadsCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { StorageService } from "./storage.service";

const PART_URL_TTL_SECONDS = 3600;
const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_PARTS = 10000;
const MIN_PART_SIZE_BYTES = 5 * 1024 * 1024;

export interface MultipartInitResult {
  uploadId: string;
  key: string;
  partSize: number;
}

export interface CompletedPart {
  partNumber: number;
  eTag: string;
}

export interface PresignedPartUrl {
  partNumber: number;
  url: string;
}

@Injectable()
export class StorageMultipartService {
  private readonly logger = new Logger(StorageMultipartService.name);

  constructor(private readonly storage: StorageService) {}

  async initiate(
    orgId: string,
    folder: string,
    fileName: string,
    mimeType: string,
    partCount: number,
  ): Promise<{ uploadId: string; key: string; partUrls: PresignedPartUrl[] }> {
    if (partCount < 1 || partCount > MAX_PARTS)
      throw new Error(`partCount must be 1–${MAX_PARTS}`);

    const placement = await this.storage.placementForOrg(orgId);
    if (!placement.bucketName)
      throw new Error("Storage bucket not configured");

    const sanitized = fileName.replace(/[^a-zA-Z0-9.-]/g, "-");
    const { randomUUID } = await import("crypto");
    const key = `${orgId}/${folder}/${randomUUID()}-${sanitized}`;

    const create = await placement.client.send(
      new CreateMultipartUploadCommand({
        Bucket: placement.bucketName,
        Key: key,
        ContentType: mimeType,
      }),
    );

    const uploadId = create.UploadId;
    if (!uploadId) throw new Error("R2/S3 did not return an uploadId");

    const partUrls: PresignedPartUrl[] = await Promise.all(
      Array.from({ length: partCount }, (_, i) => i + 1).map(async (partNumber) => {
        const cmd = new UploadPartCommand({
          Bucket: placement.bucketName,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
        });
        const url = await getSignedUrl(placement.client, cmd, {
          expiresIn: PART_URL_TTL_SECONDS,
        });
        return { partNumber, url };
      }),
    );

    return { uploadId, key, partUrls };
  }

  async complete(
    orgId: string,
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    const placement = await this.storage.placementForOrg(orgId);
    if (!placement.bucketName) throw new Error("Storage bucket not configured");

    await placement.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: placement.bucketName,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((p) => ({ PartNumber: p.partNumber, ETag: p.eTag })),
        },
      }),
    );
  }

  async abort(orgId: string, key: string, uploadId: string): Promise<void> {
    const placement = await this.storage.placementForOrg(orgId);
    if (!placement.bucketName) throw new Error("Storage bucket not configured");

    try {
      await placement.client.send(
        new AbortMultipartUploadCommand({
          Bucket: placement.bucketName,
          Key: key,
          UploadId: uploadId,
        }),
      );
    } catch (err: unknown) {
      this.logger.warn(`Abort multipart upload failed for key=${key}: ${String(err)}`);
    }
  }

  async sweepAbandonedUploads(orgId: string): Promise<number> {
    const placement = await this.storage.placementForOrg(orgId);
    if (!placement.bucketName) return 0;

    const cutoff = new Date(Date.now() - ABANDONED_AFTER_MS);
    let aborted = 0;

    let keyMarker: string | undefined;
    let uploadIdMarker: string | undefined;

    do {
      const list = await placement.client.send(
        new ListMultipartUploadsCommand({
          Bucket: placement.bucketName,
          Prefix: `${orgId}/`,
          KeyMarker: keyMarker,
          UploadIdMarker: uploadIdMarker,
        }),
      );

      for (const upload of list.Uploads ?? []) {
        if (!upload.Initiated || upload.Initiated >= cutoff) continue;
        if (!upload.Key || !upload.UploadId) continue;

        try {
          await placement.client.send(
            new AbortMultipartUploadCommand({
              Bucket: placement.bucketName,
              Key: upload.Key,
              UploadId: upload.UploadId,
            }),
          );
          aborted++;
        } catch (err: unknown) {
          this.logger.warn(
            `Could not abort stale upload key=${upload.Key} id=${upload.UploadId}: ${String(err)}`,
          );
        }
      }

      keyMarker = list.NextKeyMarker;
      uploadIdMarker = list.NextUploadIdMarker;
    } while (keyMarker || uploadIdMarker);

    if (aborted > 0)
      this.logger.log(`Swept ${aborted} abandoned multipart upload(s) for org=${orgId}`);

    return aborted;
  }

  minPartSizeBytes(): number {
    return MIN_PART_SIZE_BYTES;
  }
}
