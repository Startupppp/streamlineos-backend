import { z } from "zod";
import {
  DEFAULT_DATABASE_SHARD,
  DEFAULT_SEARCH_CLUSTER,
  LEGACY_CELL_ID,
} from "./placement";

/**
 * Where a tenant's data physically lives.
 *
 * One region is configured today, so nothing about the current deployment
 * changes. The point of naming it now is that after this, no code can reach
 * storage without saying which region it wants — and retrofitting that once
 * tenant data exists means migrating live customers between databases, which is
 * far harder than carrying the parameter from the start.
 */

export const REGION_KEY_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export interface RegionStorageConfig {
  readonly region: string;
  readonly endpoint?: string;
  readonly bucket?: string;
  readonly kbBucket?: string;
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
  readonly publicUrl?: string;
  readonly kbPublicUrl?: string;
  readonly keyPrefix?: string;
}

export const TENANT_CLASSES = ["SHARED", "DEDICATED"] as const;
export type TenantClassKey = (typeof TENANT_CLASSES)[number];

export interface RegionCellConfig {
  readonly cellId: string;
  readonly databaseShard: string;
  readonly searchCluster: string;
  readonly acceptedTenantClasses: readonly TenantClassKey[];
  readonly complianceZones: readonly string[];
  readonly cacheKeyPrefix?: string;
  readonly searchApiKey?: string;
}

export interface RegionDefinition {
  readonly key: string;
  readonly databaseUrl: string;
  readonly storage: RegionStorageConfig;
  readonly cell: RegionCellConfig;
  readonly ablyApiKey?: string;
}

export interface RegionTopology {
  /** The region new organisations are placed in. */
  readonly primary: string;
  readonly regions: Readonly<Record<string, RegionDefinition>>;
}

const keySchema = z
  .string()
  .regex(
    REGION_KEY_PATTERN,
    "a region key is lowercase letters, digits and dashes, starting with a letter",
  );

function envKey(region: string, suffix: string): string {
  return `REGION_${region.toUpperCase().replace(/-/g, "_")}_${suffix}`;
}

function read(env: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function isTenantClassKey(value: string): value is TenantClassKey {
  return TENANT_CLASSES.some((known) => known === value);
}

function parseTenantClasses(
  region: string,
  raw: string | undefined,
): readonly TenantClassKey[] {
  const values = parseList(raw).map((part) => part.toUpperCase());
  if (values.length === 0) return ["SHARED"];

  const unknown = values.filter((value) => !isTenantClassKey(value));
  if (unknown.length > 0)
    throw new Error(
      `[region] region "${region}" declares unknown tenant class(es) ${unknown.join(", ")}. ` +
        `Known: ${TENANT_CLASSES.join(", ")}.`,
    );

  return values.filter(isTenantClassKey);
}

function parseKeys(env: NodeJS.ProcessEnv, primary: string): string[] {
  const raw = read(env, "REGION_KEYS");
  if (!raw) return [primary];

  const keys = raw
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);

  return keys.includes(primary) ? keys : [primary, ...keys];
}

/**
 * Reads the topology from the environment.
 *
 * Per-region variables are `REGION_<KEY>_*`. The primary region falls back to
 * the existing flat variables, so a single-region deployment needs no
 * configuration change at all — which is what makes this safe to land before
 * any second region exists.
 */
export function resolveRegionTopology(env: NodeJS.ProcessEnv): RegionTopology {
  const primary = (read(env, "PRIMARY_REGION") ?? "primary").toLowerCase();

  const primaryCheck = keySchema.safeParse(primary);
  if (!primaryCheck.success)
    throw new Error(`[region] PRIMARY_REGION "${primary}" is invalid: ${primaryCheck.error.issues[0]?.message}`);

  const regions: Record<string, RegionDefinition> = {};

  for (const key of parseKeys(env, primary)) {
    const check = keySchema.safeParse(key);
    if (!check.success)
      throw new Error(`[region] region key "${key}" is invalid: ${check.error.issues[0]?.message}`);

    const isPrimary = key === primary;
    // Only the primary inherits the flat variables; a secondary region must be
    // configured explicitly, or a misconfiguration would silently point two
    // regions at one database.
    const flat = (...names: string[]): string[] => (isPrimary ? names : []);

    const databaseUrl = read(
      env,
      envKey(key, "APP_DATABASE_URL"),
      envKey(key, "DATABASE_URL"),
      ...flat("APP_DATABASE_URL", "DATABASE_URL"),
    );

    if (!databaseUrl)
      throw new Error(
        `[region] region "${key}" has no database. Set ${envKey(key, "APP_DATABASE_URL")}.`,
      );

    regions[key] = {
      key,
      databaseUrl,
      ablyApiKey: read(env, envKey(key, "ABLY_API_KEY")),
      cell: {
        cellId: read(env, envKey(key, "CELL_ID"), ...flat("CELL_ID")) ?? LEGACY_CELL_ID,
        databaseShard:
          read(env, envKey(key, "DATABASE_SHARD"), ...flat("DATABASE_SHARD")) ??
          DEFAULT_DATABASE_SHARD,
        searchCluster:
          read(env, envKey(key, "SEARCH_CLUSTER"), ...flat("SEARCH_CLUSTER")) ??
          DEFAULT_SEARCH_CLUSTER,
        acceptedTenantClasses: parseTenantClasses(
          key,
          read(env, envKey(key, "TENANT_CLASSES"), ...flat("TENANT_CLASSES")),
        ),
        complianceZones: parseList(
          read(env, envKey(key, "COMPLIANCE_ZONES"), ...flat("COMPLIANCE_ZONES")),
        ),
        cacheKeyPrefix: read(env, envKey(key, "CACHE_KEY_PREFIX"), ...flat("CACHE_KEY_PREFIX")),
        searchApiKey: read(env, envKey(key, "SEARCH_API_KEY"), ...flat("SEARCH_API_KEY")),
      },
      storage: {
        region: read(env, envKey(key, "R2_REGION"), ...flat("R2_REGION")) ?? "auto",
        endpoint: read(env, envKey(key, "R2_ENDPOINT"), ...flat("R2_ENDPOINT")),
        bucket: read(env, envKey(key, "R2_BUCKET_NAME"), ...flat("R2_BUCKET_NAME")),
        kbBucket: read(env, envKey(key, "R2_KB_BUCKET_NAME"), ...flat("R2_KB_BUCKET_NAME")),
        accessKeyId: read(env, envKey(key, "R2_ACCESS_KEY_ID"), ...flat("R2_ACCESS_KEY_ID")),
        secretAccessKey: read(
          env,
          envKey(key, "R2_SECRET_ACCESS_KEY"),
          ...flat("R2_SECRET_ACCESS_KEY"),
        ),
        publicUrl: read(
          env,
          envKey(key, "R2_PUBLIC_URL"),
          ...flat("NEXT_PUBLIC_R2_PUBLIC_URL"),
        ),
        kbPublicUrl: read(env, envKey(key, "R2_KB_PUBLIC_URL"), ...flat("R2_KB_PUBLIC_URL")),
        keyPrefix: read(env, envKey(key, "R2_KEY_PREFIX"), ...flat("R2_KEY_PREFIX")),
      },
    };
  }

  return { primary, regions };
}

export function isKnownRegion(topology: RegionTopology, key: string | null | undefined): boolean {
  return typeof key === "string" && Object.hasOwn(topology.regions, key);
}
