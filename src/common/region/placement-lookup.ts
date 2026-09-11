import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/drizzle.types";
import { organizationPlacement, organizations } from "../../db/schema";
import { logger } from "../logger/logger.service";
import { runOutsideTenantContext } from "../tenant/tenant-context";
import {
  DEFAULT_DATABASE_SHARD,
  DEFAULT_SEARCH_CLUSTER,
  LEGACY_CELL_ID,
  type OrganizationPlacement,
  type PlacementStatus,
} from "./placement";
import type { RegionTopology } from "./region.config";

export const FENCE_LEASE_MS = 24 * 60 * 60 * 1000;
export const FENCE_RENEW_WINDOW_MS = 6 * 60 * 60 * 1000;

export interface PlacementTransitionInput {
  readonly orgId: string;
  readonly from: PlacementStatus;
  readonly to: PlacementStatus;
  readonly currentVersion: number;
}

export interface PlacementTransitionRow {
  readonly organizationId: string;
  readonly placementVersion: number;
  readonly writeFenceToken: string;
  readonly status: PlacementStatus;
  readonly leaseExpiresAt: Date;
}

export interface PlaceOrganizationInput {
  readonly orgId: string;
  readonly region: string;
  readonly cellId?: string;
  readonly databaseShard?: string;
  readonly objectStorageRegion?: string;
  readonly searchCluster?: string;
}

export function newWriteFenceToken(): string {
  return randomUUID();
}

export async function placeOrganization(
  db: Db,
  input: PlaceOrganizationInput,
): Promise<void> {
  await runOutsideTenantContext(async () => {
    await db
      .insert(organizationPlacement)
      .values({
        organizationId: input.orgId,
        region: input.region,
        cellId: input.cellId ?? LEGACY_CELL_ID,
        databaseShard: input.databaseShard ?? DEFAULT_DATABASE_SHARD,
        objectStorageRegion: input.objectStorageRegion ?? input.region,
        searchCluster: input.searchCluster ?? DEFAULT_SEARCH_CLUSTER,
        placementVersion: 1,
        writeFenceToken: newWriteFenceToken(),
        leaseExpiresAt: new Date(Date.now() + FENCE_LEASE_MS),
        status: "ACTIVE",
      })
      .onConflictDoNothing({ target: organizationPlacement.organizationId });
  });
}

export function unplaceOrganization(db: Db, orgId: string): Promise<void> {
  return runOutsideTenantContext(async () => {
    await db
      .delete(organizationPlacement)
      .where(eq(organizationPlacement.organizationId, orgId));
  });
}

export function placedOrganizationRegion(
  db: Db,
  orgId: string,
): Promise<string | null> {
  return runOutsideTenantContext(async () => {
    const [placement] = await db
      .select({ region: organizationPlacement.region })
      .from(organizationPlacement)
      .where(eq(organizationPlacement.organizationId, orgId))
      .limit(1);
    return placement?.region ?? null;
  });
}

function cellOf(topology: RegionTopology, region: string): string | null {
  return topology.regions[region]?.cell.cellId ?? null;
}

/**
 * Deliberately outside any ambient tenant transaction: this runs *before* one is
 * opened, and letting the proxy route it into a caller's transaction would tie
 * the control-plane read to a tenant's connection — which is the wrong database
 * the moment a second region exists.
 */
export function orgPlacementLookup(
  primaryDb: Db,
  topology: RegionTopology,
): (orgId: string) => Promise<OrganizationPlacement | null> {
  return async (orgId: string): Promise<OrganizationPlacement | null> =>
    runOutsideTenantContext(async () => {
      const rows = await primaryDb
        .select({
          region: organizationPlacement.region,
          cellId: organizationPlacement.cellId,
          databaseShard: organizationPlacement.databaseShard,
          objectStorageRegion: organizationPlacement.objectStorageRegion,
          searchCluster: organizationPlacement.searchCluster,
          placementVersion: organizationPlacement.placementVersion,
          writeFenceToken: organizationPlacement.writeFenceToken,
          leaseExpiresAt: organizationPlacement.leaseExpiresAt,
          status: organizationPlacement.status,
          legacyRegion: organizations.region,
        })
        .from(organizationPlacement)
        .leftJoin(
          organizations,
          eq(organizations.id, organizationPlacement.organizationId),
        )
        .where(eq(organizationPlacement.organizationId, orgId))
        .limit(1);

      const row = rows[0];
      if (!row) return null;

      if (row.legacyRegion !== null && row.legacyRegion !== row.region)
        logger.error(
          "[region] placement diverges from the legacy region column",
          {
            orgId,
            placementRegion: row.region,
            legacyRegion: row.legacyRegion,
          },
        );

      const leaseExpiresAt = await renewLeaseIfDue(
        primaryDb,
        topology,
        orgId,
        row,
      );

      return {
        organizationId: orgId,
        region: row.region,
        cellId: row.cellId,
        databaseShard: row.databaseShard,
        objectStorageRegion: row.objectStorageRegion,
        searchCluster: row.searchCluster,
        placementVersion: row.placementVersion,
        writeFenceToken: row.writeFenceToken,
        leaseExpiresAt: leaseExpiresAt.getTime(),
        status: row.status,
      };
    });
}

interface RenewableRow {
  region: string;
  cellId: string;
  status: string;
  placementVersion: number;
  writeFenceToken: string;
  leaseExpiresAt: Date;
}

async function renewLeaseIfDue(
  db: Db,
  topology: RegionTopology,
  orgId: string,
  row: RenewableRow,
): Promise<Date> {
  const dueAt = row.leaseExpiresAt.getTime() - FENCE_RENEW_WINDOW_MS;
  if (row.status !== "ACTIVE" || Date.now() < dueAt) return row.leaseExpiresAt;
  if (cellOf(topology, row.region) !== row.cellId) return row.leaseExpiresAt;

  const renewed = await db
    .update(organizationPlacement)
    .set({ leaseExpiresAt: new Date(Date.now() + FENCE_LEASE_MS) })
    .where(
      and(
        eq(organizationPlacement.organizationId, orgId),
        eq(organizationPlacement.placementVersion, row.placementVersion),
        eq(organizationPlacement.writeFenceToken, row.writeFenceToken),
        eq(organizationPlacement.status, "ACTIVE"),
      ),
    )
    .returning({ leaseExpiresAt: organizationPlacement.leaseExpiresAt });

  return renewed[0]?.leaseExpiresAt ?? row.leaseExpiresAt;
}

export async function fetchPlacementRow(
  db: Db,
  orgId: string,
): Promise<PlacementTransitionRow | null> {
  return runOutsideTenantContext(async () => {
    const rows = await db
      .select({
        organizationId: organizationPlacement.organizationId,
        placementVersion: organizationPlacement.placementVersion,
        writeFenceToken: organizationPlacement.writeFenceToken,
        status: organizationPlacement.status,
        leaseExpiresAt: organizationPlacement.leaseExpiresAt,
      })
      .from(organizationPlacement)
      .where(eq(organizationPlacement.organizationId, orgId))
      .limit(1);
    return rows[0] ?? null;
  });
}

export async function transitionPlacementStatus(
  db: Db,
  input: PlacementTransitionInput,
): Promise<PlacementTransitionRow | null> {
  return runOutsideTenantContext(async () => {
    const rows = await db
      .update(organizationPlacement)
      .set({
        status: input.to,
        placementVersion: input.currentVersion + 1,
        writeFenceToken: newWriteFenceToken(),
      })
      .where(
        and(
          eq(organizationPlacement.organizationId, input.orgId),
          eq(organizationPlacement.status, input.from),
          eq(organizationPlacement.placementVersion, input.currentVersion),
        ),
      )
      .returning({
        organizationId: organizationPlacement.organizationId,
        placementVersion: organizationPlacement.placementVersion,
        writeFenceToken: organizationPlacement.writeFenceToken,
        status: organizationPlacement.status,
        leaseExpiresAt: organizationPlacement.leaseExpiresAt,
      });
    return rows[0] ?? null;
  });
}
