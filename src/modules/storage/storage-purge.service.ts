import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import {
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { StorageService } from "./storage.service";

export const DELETE_BATCH_LIMIT = 1_000;

export interface PurgeOrgPrefixResult {
  deleted: string[];
  skipped: string[];
  failed: Array<{ key: string; reason: string }>;
}

@Injectable()
export class StoragePurgeService {
  constructor(private readonly storage: StorageService) {}

  async purgeOrgPrefix(orgId: string): Promise<PurgeOrgPrefixResult> {
    const placement = await this.storage.placementForOrg(orgId);
    const bucket = placement.bucketName;
    if (!bucket) throw new ServiceUnavailableException("R2 bucket not configured");
    const rawPrefix = placement.keyPrefix?.replace(/\/$/, "");
    const prefix = rawPrefix ? `${rawPrefix}/` : undefined;

    const allKeys: string[] = [];
    let continuationToken: string | undefined;

    do {
      const res = await placement.client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          MaxKeys: DELETE_BATCH_LIMIT,
          ContinuationToken: continuationToken,
        }),
      );
      for (const obj of res.Contents ?? []) {
        if (typeof obj.Key === "string" && obj.Key.length > 0)
          allKeys.push(obj.Key);
      }
      continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (continuationToken !== undefined);

    const deleted: string[] = [];
    const failed: Array<{ key: string; reason: string }> = [];

    for (let i = 0; i < allKeys.length; i += DELETE_BATCH_LIMIT) {
      const batch = allKeys.slice(i, i + DELETE_BATCH_LIMIT);
      try {
        const res = await placement.client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
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
