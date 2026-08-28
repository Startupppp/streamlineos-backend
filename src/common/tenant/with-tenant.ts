import { HttpException, HttpStatus } from "@nestjs/common";
import { sql, type SQL } from "drizzle-orm";
import type { Db, TenantTx } from "../../db/drizzle.types";
import { withPoolBorrow } from "../../db/pool-telemetry";
import { resolveTransactionGuards } from "../../db/pool.config";
import type { TenantAudience } from "./tenant-context";
import { getRegionRegistry, hasRegionRegistry } from "../region/region-registry";
import type { OrganizationPlacement, PlacementIntent } from "../region/placement";

export type { TenantTx };

function buildGuardSettings(): SQL[] {
  const guards = resolveTransactionGuards(process.env);
  const settings: SQL[] = [];

  if (guards.statementTimeoutMs > 0)
    settings.push(sql`set_config('statement_timeout', ${String(guards.statementTimeoutMs)}, true)`);
  if (guards.idleInTransactionMs > 0)
    settings.push(
      sql`set_config('idle_in_transaction_session_timeout', ${String(guards.idleInTransactionMs)}, true)`,
    );
  if (guards.lockTimeoutMs > 0)
    settings.push(sql`set_config('lock_timeout', ${String(guards.lockTimeoutMs)}, true)`);

  return settings;
}

const GUARD_SETTINGS = buildGuardSettings();

const FENCE_HELD_COLUMN = "placement_fence_held";
const FENCE_RETRY_AFTER_MS = 5_000;

export class WriteFenceLostError extends HttpException {
  constructor(orgId: string, placement: OrganizationPlacement) {
    super(
      {
        code: "PLACEMENT_FENCE_LOST",
        message:
          `This cell no longer holds the write fence for organisation ${orgId} at placement ` +
          `version ${placement.placementVersion}. Re-resolve placement and retry.`,
        details: {
          retryable: true,
          retryAfterMs: FENCE_RETRY_AFTER_MS,
          cellId: placement.cellId,
          placementVersion: placement.placementVersion,
        },
      },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
    this.name = "WriteFenceLostError";
  }
}

/**
 * Picks the connection for the organisation's region.
 *
 * This lives inside `withTenant` rather than at its callers because a caller
 * added later would otherwise reach the wrong database with nothing to catch
 * it. Resolution here is a property of opening a tenant transaction, not
 * something a caller can forget — which is the same reason the write fence is
 * checked here and not at the call sites.
 *
 * Falls back to the given connection only when no registry is configured, which
 * is the unit-test path: `RegionModule` is global and eager, so a booted
 * application always has one, and `RegionModule.onApplicationBootstrap` refuses
 * to serve traffic otherwise.
 */
async function resolvePlacement(
  orgId: string,
  intent: PlacementIntent,
): Promise<OrganizationPlacement | null> {
  if (!hasRegionRegistry()) return null;
  return getRegionRegistry().admittedPlacementForOrg(orgId, intent);
}

function fenceProbe(orgId: string, placement: OrganizationPlacement): SQL {
  return sql`(SELECT count(*) FROM organization_placement
    WHERE organization_id = ${orgId}
      AND placement_version = ${placement.placementVersion}
      AND write_fence_token = ${placement.writeFenceToken}
      AND status = 'ACTIVE'
      AND lease_expires_at > now()) AS ${sql.raw(FENCE_HELD_COLUMN)}`;
}

function fenceIsHeld(rows: unknown): boolean {
  if (!Array.isArray(rows)) return false;
  const row: unknown = rows[0];
  if (typeof row !== "object" || row === null) return false;
  return Number(Reflect.get(row, FENCE_HELD_COLUMN)) === 1;
}

/**
 * Runs `fn` inside a transaction whose tenant GUCs are set for its duration, and
 * is therefore also where a pooled connection is borrowed for a request's
 * lifetime — so both the borrow and the timeouts bounding it belong here. Neon's
 * pooler drops those timeouts when sent as startup parameters, and `is_local`
 * reverts them at COMMIT before the connection serves the next tenant. The
 * placement version rides the same mechanism for the same reason.
 */
export async function withTenant<T>(
  db: Db,
  context: {
    orgId: string;
    audience: TenantAudience;
    intent?: PlacementIntent;
  },
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  if (!context.orgId)
    throw new Error("withTenant: orgId must be a non-empty string");

  const intent = context.intent ?? "write";
  const placement = await resolvePlacement(context.orgId, intent);
  const regional = placement
    ? getRegionRegistry().bindingFor(placement.region).db
    : db;

  const fenced =
    intent === "write" && placement !== null && placement.writeFenceToken !== null;

  const settings = sql.join(
    [
      sql`set_config('app.organization_id', ${context.orgId}, true)`,
      sql`set_config('app.audience', ${context.audience}, true)`,
      ...(placement
        ? [
            sql`set_config('app.placement_version', ${String(placement.placementVersion)}, true)`,
            sql`set_config('app.cell_id', ${placement.cellId}, true)`,
          ]
        : []),
      ...GUARD_SETTINGS,
      ...(fenced && placement ? [fenceProbe(context.orgId, placement)] : []),
    ],
    sql`, `,
  );

  return withPoolBorrow((borrow) =>
    regional.transaction(async (tx) => {
      borrow.acquired();
      const rows = await tx.execute(sql`SELECT ${settings}`);
      if (fenced && placement && !fenceIsHeld(rows))
        throw new WriteFenceLostError(context.orgId, placement);
      return fn(tx);
    }),
  );
}
