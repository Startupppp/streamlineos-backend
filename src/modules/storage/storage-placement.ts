import { ServiceUnavailableException } from "@nestjs/common";
import { randomUUID } from "crypto";
import { S3Client } from "@aws-sdk/client-s3";
import { sanitizeFileName } from "./storage-key";
import type { AppConfig } from "../../config/env.validation";
import {
  getRegionRegistry,
  hasRegionRegistry,
} from "../../common/region/region-registry";
import type { RegionStorageConfig } from "../../common/region/region.config";

export interface R2Config {
  region: string;
  bucketName: string | undefined;
  accessKeyId: string | undefined;
  secretAccessKey: string | undefined;
  endpoint: string | undefined;
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

/**
 * Answers where an organisation's bytes live and with which client, so the object
 * operations above it never resolve a region, a credential or a bucket themselves.
 *
 * The two questions change for different reasons: placement changes when a region is
 * added, re-homed or loses its registry, object operations when the storage protocol
 * does. Clients are cached per credential set because an S3Client holds a connection
 * pool and one per call exhausts sockets under load.
 */
export class StoragePlacementResolver {
  private readonly clients = new Map<string, S3Client>();

  constructor(private readonly config: StorageConfig) {}

  static toR2Config(storage: RegionStorageConfig): R2Config {
    return {
      region: storage.region,
      bucketName: storage.bucket,
      accessKeyId: storage.accessKeyId,
      secretAccessKey: storage.secretAccessKey,
      endpoint: storage.endpoint,
    };
  }

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

  async forOrg(orgId: string): Promise<StoragePlacement> {
    if (!hasRegionRegistry()) {
      const cfg = this.primaryConfig();
      return {
        client: this.clientFor(cfg),
        bucketName: cfg.bucketName,
      };
    }

    const storage = await getRegionRegistry().storageForOrg(orgId);
    const cfg = StoragePlacementResolver.toR2Config(storage);
    return {
      client: this.clientFor(cfg),
      bucketName: cfg.bucketName,
      keyPrefix: storage.keyPrefix,
    };
  }

  primaryConfig(): R2Config {
    if (hasRegionRegistry()) {
      const registry = getRegionRegistry();
      return StoragePlacementResolver.toR2Config(
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
    return StoragePlacementResolver.toR2Config(
      await getRegionRegistry().storageForOrg(orgId),
    );
  }

  isConfigured(): boolean {
    const config = this.primaryConfig();
    return Boolean(
      config.bucketName &&
      config.accessKeyId &&
      config.secretAccessKey &&
      config.endpoint,
    );
  }

  requireBucket(placement: StoragePlacement, override?: string): string {
    const bucket = override || placement.bucketName;
    if (!bucket)
      throw new ServiceUnavailableException("R2 bucket not configured");
    return bucket;
  }

  objectKey(
    placement: StoragePlacement,
    orgId: string,
    folder: string,
    fileName: string,
  ): string {
    const rawKey = `${orgId}/${folder}/${randomUUID()}-${sanitizeFileName(fileName)}`;
    return placement.keyPrefix ? `${placement.keyPrefix}/${rawKey}` : rawKey;
  }
}
