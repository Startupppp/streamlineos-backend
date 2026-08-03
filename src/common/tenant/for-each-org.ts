import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import { organizations } from "../../db/schema";
import { logger } from "../logger/logger.service";
import { runWithTenantContext } from "./tenant-context";
import { withTenant, type TenantTx } from "./with-tenant";

export interface ForEachOrgResult {
  organizations: number;
  succeeded: number;
  failed: number;
}

/**
 * Runs a sweep once per organization, each inside its own tenant transaction.
 *
 * Background sweeps used to open with a cross-org discovery query — "every
 * certification expiring this week", across all tenants at once. Under RLS that
 * query has no tenant context and is denied, so discovery has to move inside the
 * per-org loop. `organizations` itself carries no tenant column and therefore no
 * policy, which is what makes enumerating them possible without a bypass role.
 *
 * One organization failing must not abort the rest of the sweep, so each is
 * isolated: its transaction rolls back alone and the loop continues.
 */
export async function forEachOrg(
  db: Db,
  sweep: string,
  fn: (tx: TenantTx, orgId: string) => Promise<void>,
): Promise<ForEachOrgResult> {
  // status, not just deletedAt: the purge worker parks an org in PURGE_SCHEDULED/PURGED without soft-deleting it
  const orgs = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(isNull(organizations.deletedAt), eq(organizations.status, "ACTIVE")))
    .orderBy(asc(organizations.id));

  let succeeded = 0;
  let failed = 0;

  for (const org of orgs) {
    try {
      // The context, not just the transaction: nested services hold the proxied db, not this tx
      await withTenant(db, { orgId: org.id, audience: "INTERNAL" }, (tx) =>
        runWithTenantContext({ orgId: org.id, audience: "INTERNAL", tx }, () => fn(tx, org.id)),
      );
      succeeded += 1;
    } catch (err) {
      failed += 1;
      logger.error(`[${sweep}] organization sweep failed`, {
        orgId: org.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { organizations: orgs.length, succeeded, failed };
}
