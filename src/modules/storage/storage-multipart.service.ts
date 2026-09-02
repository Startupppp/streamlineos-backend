import { Injectable, Logger } from "@nestjs/common";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  ListMultipartUploadsCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { StorageService, isMissingObjectError } from "./storage.service";
import { sanitizeFileName } from "./storage-key";

const PART_URL_TTL_SECONDS = 3600;
const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_PARTS = 10000;
const MIN_PART_SIZE_BYTES = 5 * 1024 * 1024;

export interface CompletedPart {
  partNumber: number;
  eTag: string;
}

export interface PresignedPartUrl {
  partNumber: number;
  url: string;
}

export type CompletionOutcome =
  | "completed"
  | "already-completed"
  | "unknown-upload";

function isUnknownUploadError(error: unknown): boolean {
  if (isMissingObjectError(error)) return true;
  if (!(error instanceof Error)) return false;
  const details = error as Error & { name?: string; Code?: string };
  return details.name === "NoSuchUpload" || details.Code === "NoSuchUpload";
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

    const { randomUUID } = await import("crypto");
    const key = `${orgId}/${folder}/${randomUUID()}-${sanitizeFileName(fileName)}`;

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

  /**
   * A retried completion is the normal case, not the exception: the client
   * cannot tell a lost response from a lost request. S3 and R2 forget the
   * upload id the moment the first completion succeeds, so the second attempt
   * fails `NoSuchUpload` — which is indistinguishable from a bogus id unless
   * the object itself is consulted. Answering "already-completed" is what keeps
   * the retry from either duplicating the record or orphaning the object.
   */
  async complete(
    orgId: string,
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<CompletionOutcome> {
    const placement = await this.storage.placementForOrg(orgId);
    if (!placement.bucketName) throw new Error("Storage bucket not configured");

    try {
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
      return "completed";
    } catch (error) {
      if (!isUnknownUploadError(error)) throw error;
      const existing = await this.storage.describeObject(orgId, key);
      if (existing) return "already-completed";
      return "unknown-upload";
    }
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
      this.logger.warn(`Abort multipart upload failed: ${String(err)}`, { key });
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
          this.logger.warn(`Could not abort stale upload: ${String(err)}`, {
            key: upload.Key,
            uploadId: upload.UploadId,
          });
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
