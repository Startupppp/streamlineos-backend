import { ServiceUnavailableException } from "@nestjs/common";
import { S3Client } from "@aws-sdk/client-s3";
import type { AppConfig } from "../../../config/env.validation";
import {
  getRegionRegistry,
  hasRegionRegistry,
} from "../../../common/region/region-registry";
import type { RegionStorageConfig } from "../../../common/region/region.config";

/**
 * Which bucket, which client, which public base — decided before any byte moves.
 *
 * `StorageService` has two jobs stacked on top of each other. The lower one is
 * the five S3 verbs: put, get, head, delete, sign. The upper one, here, never
 * touches S3 at all — it answers *where this organisation's objects live*, and
 * it has an entirely different shape: two configuration sources (the region
 * registry when the deployment is celled, `APP_CONFIG` when it is not), a
 * credential-keyed client cache, and the rule that decides whether a key is
 * handed back as a public URL or as a bare key.
 *
 * That last rule is the reason this is worth separating rather than merely
 * shorter. `publicUrlFor` is the only thing standing between an HR document and
 * a publicly fetchable link: `PRIVATE_HR_FOLDERS` is matched on the *first*
 * path segment, so `hr-documents/2026/contract.pdf` is caught by its root. It
 * was previously seven lines in the middle of four hundred.
 *
 * The client cache stays on the service instance and is passed in, rather than
 * becoming a module-level map — a process-wide cache would be shared between
 * two `StorageService` instances, which is not what the constructor promises.
 *
 * Free functions over a deps bag, not a second `@Injectable`: the DI graph and
 * every caller are unchanged.
 */

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
  readonly publicUrl?: string;
  readonly keyPrefix?: string;
}

export interface StoragePlacementDeps {
  readonly config: StorageConfig;
  /** The service instance's own client cache, keyed by region|endpoint|accessKeyId. */
  readonly clients: Map<string, S3Client>;
}

/**
 * Folders whose objects are never given out as a URL.
 *
 * Matched on the first path segment, so everything nested under one of these is
 * covered too.
 */
const PRIVATE_HR_FOLDERS = new Set([
  "documents",
  "hr-documents",
  "onboarding",
  "onboarding-docs",
  "resignations",
  "hr-exports",
]);

export function clientFor(deps: StoragePlacementDeps, cfg: R2Config): S3Client {
  const cacheKey = `${cfg.region}|${cfg.endpoint ?? ""}|${cfg.accessKeyId ?? ""}`;
  const existing = deps.clients.get(cacheKey);
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
  deps.clients.set(cacheKey, client);
  return client;
}

export async function placementFor(deps: StoragePlacementDeps, orgId: string): Promise<StoragePlacement> {
  if (!hasRegionRegistry()) {
    const cfg = getConfig(deps);
    return {
      client: clientFor(deps, cfg),
      bucketName: cfg.bucketName,
      publicUrl: deps.config.NEXT_PUBLIC_R2_PUBLIC_URL,
    };
  }

  const storage = await getRegionRegistry().storageForOrg(orgId);
  const cfg = toR2Config(storage);
  return {
    client: clientFor(deps, cfg),
    bucketName: cfg.bucketName,
    publicUrl: storage.publicUrl ?? deps.config.NEXT_PUBLIC_R2_PUBLIC_URL,
    keyPrefix: storage.keyPrefix,
  };
}

function toR2Config(storage: RegionStorageConfig): R2Config {
  return {
    region: storage.region,
    bucketName: storage.bucket,
    accessKeyId: storage.accessKeyId,
    secretAccessKey: storage.secretAccessKey,
    endpoint: storage.endpoint,
  };
}

export function getConfig(deps: StoragePlacementDeps): R2Config {
  if (hasRegionRegistry()) {
    const registry = getRegionRegistry();
    return toR2Config(
      registry.bindingFor(registry.primary).definition.storage,
    );
  }

  return {
    region: deps.config.R2_REGION ?? "auto",
    bucketName: deps.config.R2_BUCKET_NAME,
    accessKeyId: deps.config.R2_ACCESS_KEY_ID,
    secretAccessKey: deps.config.R2_SECRET_ACCESS_KEY,
    endpoint: deps.config.R2_ENDPOINT,
  };
}

export async function configForOrg(orgId: string): Promise<R2Config> {
  return toR2Config(
    await getRegionRegistry().storageForOrg(orgId),
  );
}

export function isConfigured(deps: StoragePlacementDeps): boolean {
  const config = getConfig(deps);
  return Boolean(
    config.bucketName &&
    config.accessKeyId &&
    config.secretAccessKey &&
    config.endpoint,
  );
}

export function requireBucketFrom(
  placement: StoragePlacement,
  override?: string,
): string {
  const bucket = override || placement.bucketName;
  if (!bucket)
    throw new ServiceUnavailableException("R2 bucket not configured");
  return bucket;
}

/**
 * A public URL, or the bare key when the folder is private.
 *
 * `compressAndPreGenerateKey` calls this with three arguments, so its override
 * lands in the `regionPublicUrl` slot; the `override ?? regionPublicUrl` below
 * makes that work out to the same base. Preserved as it shipped.
 */
export function publicUrlFor(
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
