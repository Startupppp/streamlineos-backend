import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/drizzle.types";
import { organizationRelocations } from "../../db/schema/common/relocation";
import { recordTargetRequest } from "./relocation-traffic";

export const REFRESH_INTERVAL_MS = 30_000;

export interface TrackedTarget {
  readonly orgId: string;
  readonly cellId: string;
}

let tracked: ReadonlyMap<string, string> = new Map();
let refreshedAtMs = 0;
let inFlight: Promise<void> | null = null;

export function resetRelocationTrafficTracker(): void {
  tracked = new Map();
  refreshedAtMs = 0;
  inFlight = null;
}

function trackedTargets(): ReadonlyMap<string, string> {
  return tracked;
}

export function primeRelocationTrafficTracker(
  targets: readonly TrackedTarget[],
  nowMs: number,
): void {
  tracked = new Map(targets.map((t) => [t.orgId, t.cellId]));
  refreshedAtMs = nowMs;
}

export async function loadActiveRelocationTargets(db: Db): Promise<readonly TrackedTarget[]> {
  const rows = await db
    .select({
      orgId: organizationRelocations.organizationId,
      cellId: organizationRelocations.targetCell,
    })
    .from(organizationRelocations)
    .where(
      and(
        eq(organizationRelocations.isActive, true),
        eq(organizationRelocations.currentState, "ACTIVE_TARGET"),
      ),
    )
    .limit(10_000);
  return rows.map((row) => ({ orgId: row.orgId, cellId: row.cellId }));
}

export async function refreshRelocationTargets(
  db: Db,
  nowMs: number,
  loader: (db: Db) => Promise<readonly TrackedTarget[]> = loadActiveRelocationTargets,
): Promise<void> {
  if (nowMs - refreshedAtMs < REFRESH_INTERVAL_MS) return;
  if (inFlight !== null) return inFlight;
  inFlight = loader(db)
    .then((targets) => {
      tracked = new Map(targets.map((t) => [t.orgId, t.cellId]));
      refreshedAtMs = nowMs;
    })
    .catch(() => undefined)
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function isRelocationTarget(orgId: string, cellId: string | null): boolean {
  if (cellId === null) return false;
  return tracked.get(orgId) === cellId;
}

async function countRequestIfRelocationTarget(
  db: Db,
  orgId: string,
  cellId: string | null,
): Promise<void> {
  if (cellId === null) return;
  if (!isRelocationTarget(orgId, cellId)) return;
  await recordTargetRequest(db, orgId, cellId);
}
