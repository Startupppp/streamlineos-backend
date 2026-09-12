import { sql } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.module";
import { CacheService } from "../../../../common/cache/cache.service";
import { NotificationsService } from "../../../notifications/notifications.service";
import type { LimitKey } from "../plan-entitlements.constants";
import { LIMIT_KEY_LABELS } from "./plan-limit-counts";

/**
 * Telling the owner a quota is filling up, which is not enforcement.
 *
 * `assertWithinLimit` refuses a write with a 402 the caller sees immediately.
 * This is the opposite kind of code on every axis: it is `void`-ed rather than
 * awaited, it is optional (`notifications` is `@Optional()` and null in most
 * tests and in every script), every one of its failures is swallowed —
 * `findOrgOwnerForAlert` returns null on a query error rather than throwing —
 * and it must never fire twice for the same threshold, which is why each alert
 * is deduplicated in the cache for thirty days rather than being derived fresh.
 *
 * Nothing here can change whether a write is allowed. That is the seam: this
 * file may be wrong and the plan is still enforced correctly.
 */
export interface QuotaAlertDeps {
  readonly db: Db;
  readonly cache: CacheService;
  readonly notifications: NotificationsService | null;
}

/** Long enough that an org sitting at 81% is told once, not every write. */
const QUOTA_ALERT_TTL_SECONDS = 30 * 24 * 60 * 60;

function crossedThresholds(afterCount: number, limit: number): number[] {
  const result: number[] = [];
  if (afterCount >= limit) result.push(100);
  if (afterCount >= limit * 0.8) result.push(80);
  return result;
}

async function findOrgOwnerForAlert(deps: QuotaAlertDeps, orgId: string): Promise<{ userId: string } | null> {
  try {
    const rows = await deps.db.execute(
      sql`SELECT om.user_id FROM organization_members om
          INNER JOIN users u ON u.id = om.user_id
          WHERE om.org_id = ${orgId} AND om.is_owner = true AND u.is_active = true
          LIMIT 1`,
    );
    const row = rows[0];
    if (!row) return null;
    const userId = String(row["user_id"] ?? "");
    return userId ? { userId } : null;
  } catch {
    return null;
  }
}

export async function maybeAlertQuota(
  deps: QuotaAlertDeps,
  orgId: string,
  key: LimitKey,
  afterCount: number,
  limit: number,
): Promise<void> {
  if (!deps.notifications) return;

  const thresholds = crossedThresholds(afterCount, limit);
  if (thresholds.length === 0) return;

  const owner = await findOrgOwnerForAlert(deps, orgId);
  if (!owner) return;

  const label = LIMIT_KEY_LABELS[key];

  for (const pct of thresholds) {
    const dedupKey = `billing:quota-alert:${orgId}:${key}:${pct}`;
    const alreadySent = await deps.cache.get<boolean>(dedupKey);
    if (alreadySent) continue;

    const is100 = pct === 100;
    await deps.notifications.create({
      orgId,
      userId: owner.userId,
      type: is100 ? "WARNING" : "INFO",
      priority: is100 ? "HIGH" : "NORMAL",
      category: "BILLING",
      sourceModule: "billing",
      eventKey: is100 ? "billing.quota.exceeded" : "billing.quota.warning",
      title: is100
        ? `${label} limit reached (${afterCount}/${limit})`
        : `${label} at 80% of limit (${afterCount}/${limit})`,
      message: is100
        ? `Your workspace has used all ${limit} ${label}. New additions are now blocked. Upgrade your plan to continue.`
        : `Your workspace has used ${afterCount} of ${limit} ${label} (${Math.round((afterCount / limit) * 100)}%). Consider upgrading before you hit the limit.`,
      link: "/settings/billing",
    });

    await deps.cache.set(dedupKey, true, QUOTA_ALERT_TTL_SECONDS);
  }
}
