export const ORGANIZATION_PLACEMENT_STATUSES = [
  "ACTIVE",
  "MOVING",
  "READ_ONLY",
  "FAILED",
] as const;

export type PlacementStatus = (typeof ORGANIZATION_PLACEMENT_STATUSES)[number];

export type PlacementIntent = "read" | "write";

export const LEGACY_CELL_ID = "legacy-1";
export const DEFAULT_DATABASE_SHARD = "primary";
export const DEFAULT_SEARCH_CLUSTER = "primary";

export interface OrganizationPlacement {
  readonly organizationId: string;
  readonly region: string;
  readonly cellId: string;
  readonly databaseShard: string;
  readonly objectStorageRegion: string;
  readonly searchCluster: string;
  readonly placementVersion: number;
  readonly writeFenceToken: string | null;
  readonly leaseExpiresAt: number | null;
  readonly status: PlacementStatus;
}

export type PlacementRefusalCode =
  | "PLACEMENT_RELOCATING"
  | "PLACEMENT_READ_ONLY"
  | "PLACEMENT_FAILED"
  | "PLACEMENT_LEASE_EXPIRED";

export type PlacementDecision =
  | { readonly admitted: true }
  | {
      readonly admitted: false;
      readonly code: PlacementRefusalCode;
      readonly message: string;
      readonly retryable: boolean;
      readonly retryAfterMs: number | null;
    };

const RELOCATION_RETRY_MS = 5_000;

export function decidePlacement(
  placement: OrganizationPlacement,
  intent: PlacementIntent,
  now: number,
): PlacementDecision {
  if (placement.status === "FAILED")
    return {
      admitted: false,
      code: "PLACEMENT_FAILED",
      message: `Organisation ${placement.organizationId} has a failed placement and cannot be served from ${placement.cellId}.`,
      retryable: false,
      retryAfterMs: null,
    };

  if (intent === "read") return { admitted: true };

  if (placement.status === "MOVING")
    return {
      admitted: false,
      code: "PLACEMENT_RELOCATING",
      message: `Organisation ${placement.organizationId} is moving between cells. Reads continue; writes resume once the move completes.`,
      retryable: true,
      retryAfterMs: RELOCATION_RETRY_MS,
    };

  if (placement.status === "READ_ONLY")
    return {
      admitted: false,
      code: "PLACEMENT_READ_ONLY",
      message: `Organisation ${placement.organizationId} is placed read-only in ${placement.cellId}.`,
      retryable: false,
      retryAfterMs: null,
    };

  if (placement.leaseExpiresAt !== null && placement.leaseExpiresAt <= now)
    return {
      admitted: false,
      code: "PLACEMENT_LEASE_EXPIRED",
      message: `The write fence for organisation ${placement.organizationId} in ${placement.cellId} expired at ${new Date(placement.leaseExpiresAt).toISOString()}.`,
      retryable: true,
      retryAfterMs: RELOCATION_RETRY_MS,
    };

  return { admitted: true };
}

export function placementFromRegion(
  organizationId: string,
  region: string,
  storageRegion: string,
): OrganizationPlacement {
  return {
    organizationId,
    region,
    cellId: LEGACY_CELL_ID,
    databaseShard: DEFAULT_DATABASE_SHARD,
    objectStorageRegion: storageRegion,
    searchCluster: DEFAULT_SEARCH_CLUSTER,
    placementVersion: 1,
    writeFenceToken: null,
    leaseExpiresAt: null,
    status: "ACTIVE",
  };
}

export function isPlacementStatus(value: unknown): value is PlacementStatus {
  return (
    typeof value === "string" &&
    (ORGANIZATION_PLACEMENT_STATUSES as readonly string[]).includes(value)
  );
}
