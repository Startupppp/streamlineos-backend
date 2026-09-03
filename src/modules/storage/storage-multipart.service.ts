import { Injectable, Logger } from "@nestjs/common";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  ListMultipartUploadsCommand,
  UploadPartCommand,
  type S3Client,
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

/** One bucket, and the organisations whose objects live in it. */
interface BucketSweep {
  readonly client: S3Client;
  readonly bucketName: string;
  readonly orgIds: Set<string>;
}

/**
 * The organisation a multipart key belongs to.
 *
 * `initiate` above builds every key as `<orgId>/<folder>/<uuid>-<name>`, so the first
 * path segment is the owner and a key with no segment separator belongs to nobody.
 * Returning `""` for that case is deliberate: no organisation identifier is empty, so
 * an unattributable key never matches a swept organisation and is never aborted.
 */
function owningOrgOf(key: string): string {
  const slash = key.indexOf("/");
  return slash <= 0 ? "" : key.slice(0, slash);
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

  /**
   * One list per BUCKET, not one per organisation.
   *
   * This used to take a single `orgId` and ask the object store for
   * `Prefix: <orgId>/`, and `CronStorageSweepService` calls it from inside
   * `forEachOrg` — so the sweep issued one outbound `ListMultipartUploads` per
   * organisation. That is O(organisations swept): 8 measured outbound calls on the
   * perf seed's 8 organisations, and one per tenant on a real deployment, against a
   * declared `maxDownstreamCalls` of 0. The magnitude was never the interesting part;
   * the UNIT was wrong, because the reconciliation does not need a call per tenant.
   *
   * In-progress multipart uploads are rare and short-lived, and one unprefixed list
   * returns up to a thousand of them, so the same reconciliation costs one round trip
   * per distinct bucket plus one per pagination page — independent of how many
   * organisations share that bucket. The abort calls that follow are unchanged and
   * stay proportional to the objects actually abandoned.
   *
   * The organisation filter is preserved exactly rather than dropped along with the
   * prefix: only an upload whose key begins with a swept organisation's identifier is
   * aborted, so an upload sitting under an unknown, unswept or soft-deleted prefix
   * survives here just as it did when each organisation asked for its own prefix.
   *
   * It cannot reach zero outbound calls, and it should not: reconciling the object
   * store is what this sweep is for, and a sweep that never asks the store what is
   * there cannot find the orphan a crash between `CreateMultipartUpload` and the
   * database left behind.
   */
  async sweepAbandonedUploadsForOrgs(orgIds: readonly string[]): Promise<number> {
    const buckets = await this.groupByBucket(orgIds);
    const cutoff = new Date(Date.now() - ABANDONED_AFTER_MS);

    let aborted = 0;
    for (const bucket of buckets) {
      // Per bucket, so one unreachable region does not cost the others their sweep —
      // the isolation the per-organisation caller used to provide.
      try {
        aborted += await this.sweepBucket(bucket, cutoff);
      } catch (err: unknown) {
        this.logger.warn(`Multipart sweep failed for bucket: ${String(err)}`, {
          bucket: bucket.bucketName,
          organizations: bucket.orgIds.size,
        });
      }
    }
    return aborted;
  }

  /**
   * Placement resolution is per organisation and stays that way — it is a local
   * lookup, not a round trip — but two organisations that resolve to the same client
   * AND the same bucket are one sweep. Client identity is part of the key because two
   * regions may legitimately name their buckets alike while pointing at different
   * endpoints and credentials.
   */
  private async groupByBucket(orgIds: readonly string[]): Promise<BucketSweep[]> {
    const buckets: BucketSweep[] = [];
    for (const orgId of orgIds) {
      const placement = await this.storage.placementForOrg(orgId);
      if (!placement.bucketName) continue;
      const existing = buckets.find(
        (b) => b.client === placement.client && b.bucketName === placement.bucketName,
      );
      if (existing) existing.orgIds.add(orgId);
      else
        buckets.push({
          client: placement.client,
          bucketName: placement.bucketName,
          orgIds: new Set([orgId]),
        });
    }
    return buckets;
  }

  private async sweepBucket(bucket: BucketSweep, cutoff: Date): Promise<number> {
    let aborted = 0;
    let keyMarker: string | undefined;
    let uploadIdMarker: string | undefined;

    do {
      const list = await bucket.client.send(
        new ListMultipartUploadsCommand({
          Bucket: bucket.bucketName,
          KeyMarker: keyMarker,
          UploadIdMarker: uploadIdMarker,
        }),
      );

      for (const upload of list.Uploads ?? []) {
        if (!upload.Initiated || upload.Initiated >= cutoff) continue;
        if (!upload.Key || !upload.UploadId) continue;
        if (!bucket.orgIds.has(owningOrgOf(upload.Key))) continue;

        try {
          await bucket.client.send(
            new AbortMultipartUploadCommand({
              Bucket: bucket.bucketName,
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
      this.logger.log(
        `Swept ${aborted} abandoned multipart upload(s) in bucket=${bucket.bucketName}`,
      );

    return aborted;
  }

  minPartSizeBytes(): number {
    return MIN_PART_SIZE_BYTES;
  }
}
