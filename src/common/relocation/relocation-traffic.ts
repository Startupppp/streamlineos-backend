import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../../db/drizzle.types";
import { organizationCellTraffic } from "../../db/schema";
import { RelocationTransitionError } from "./relocation-state";

export const RETIRE_GATE = {
  minRequests: 25,
  windowMs: 10 * 60 * 1000,
} as const;

export interface TrafficRecord {
  readonly requestCount: number;
  readonly windowStart: Date;
}

export type RetireGateResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

export function evaluateRetireGate(
  traffic: TrafficRecord | null,
  now: Date,
): RetireGateResult {
  const needed = RETIRE_GATE.minRequests;
  const windowMs = RETIRE_GATE.windowMs;

  if (traffic === null) {
    const since = new Date(now.getTime() - windowMs).toISOString();
    return {
      allowed: false,
      reason: `target has served 0 requests, needs ${needed} since ${since}`,
    };
  }

  const served = traffic.requestCount;
  const elapsed = now.getTime() - traffic.windowStart.getTime();
  const windowOpen = elapsed >= windowMs;
  const enoughRequests = served >= needed;

  if (enoughRequests && windowOpen) return { allowed: true };

  const since = traffic.windowStart.toISOString();

  if (!enoughRequests)
    return {
      allowed: false,
      reason: `target has served ${served} requests, needs ${needed} since ${since}`,
    };

  return {
    allowed: false,
    reason:
      `target has served ${served} requests since ${since}; ` +
      `window has not elapsed (${Math.round(elapsed / 1000)}s of ${windowMs / 1000}s required)`,
  };
}

export function assertRetireGateOpen(
  traffic: TrafficRecord | null,
  now: Date,
): void {
  const result = evaluateRetireGate(traffic, now);
  if (!result.allowed)
    throw new RelocationTransitionError("ILLEGAL_TRANSITION", result.reason);
}

export async function initTargetTrafficWindow(
  db: Db,
  orgId: string,
  cellId: string,
): Promise<void> {
  const now = new Date();
  await db
    .insert(organizationCellTraffic)
    .values({ orgId, cellId, requestCount: 0, windowStart: now, lastSeenAt: now })
    .onConflictDoUpdate({
      target: [organizationCellTraffic.orgId, organizationCellTraffic.cellId],
      set: { requestCount: 0, windowStart: now, lastSeenAt: now },
    });
}

export async function recordTargetRequest(
  db: Db,
  orgId: string,
  cellId: string,
): Promise<void> {
  await db
    .insert(organizationCellTraffic)
    .values({
      orgId,
      cellId,
      requestCount: 1,
      windowStart: new Date(),
      lastSeenAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [organizationCellTraffic.orgId, organizationCellTraffic.cellId],
      set: {
        requestCount: sql`${organizationCellTraffic.requestCount} + 1`,
        lastSeenAt: sql`NOW()`,
      },
    });
}

export async function readTargetTraffic(
  db: Db,
  orgId: string,
  cellId: string,
): Promise<TrafficRecord | null> {
  const rows = await db
    .select({
      requestCount: organizationCellTraffic.requestCount,
      windowStart: organizationCellTraffic.windowStart,
    })
    .from(organizationCellTraffic)
    .where(
      and(
        eq(organizationCellTraffic.orgId, orgId),
        eq(organizationCellTraffic.cellId, cellId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { requestCount: row.requestCount, windowStart: row.windowStart };
}
