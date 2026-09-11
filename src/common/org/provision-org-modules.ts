import { eq, sql } from "drizzle-orm";
import {
  moduleOwnerships,
  modulesCatalog,
  orgModules,
  organizations,
} from "../../db/schema";
import { ACCESS_MANAGED_MODULES } from "../rbac/module-vocabulary";
import { type TenantTx } from "../tenant/with-tenant";

export const DEFAULT_SKIP_MODULES = ["hr", "crm", "build"] as const;

const OWNERSHIP_MANAGED_MODULES = new Set<string>(ACCESS_MANAGED_MODULES);

export async function provisionOrgModules(
  tx: TenantTx,
  orgId: string,
  moduleKeys: readonly string[],
  enabledBy: string,
): Promise<void> {
  const selected = new Set(moduleKeys);
  const catalog = await tx
    .select({ moduleKey: modulesCatalog.moduleKey, isCore: modulesCatalog.isCore })
    .from(modulesCatalog);

  const rows =
    catalog.length > 0
      ? catalog.map((entry) => ({
          orgId,
          moduleKey: entry.moduleKey,
          enabled: entry.isCore === true || selected.has(entry.moduleKey),
          enabledBy,
        }))
      : moduleKeys.map((moduleKey) => ({ orgId, moduleKey, enabled: true, enabledBy }));

  if (rows.length === 0) return;

  await tx
    .insert(orgModules)
    .values(rows)
    .onConflictDoUpdate({
      target: [orgModules.orgId, orgModules.moduleKey],
      set: { enabled: sql`excluded.enabled`, enabledBy: sql`excluded.enabled_by` },
    });

  const eligibleKeys = moduleKeys.filter((key) => OWNERSHIP_MANAGED_MODULES.has(key));
  if (eligibleKeys.length === 0) return;

  const [orgRow] = await tx
    .select({ ownerMembershipId: organizations.ownerMembershipId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  const ownerMembershipId = orgRow?.ownerMembershipId;
  if (ownerMembershipId === null || ownerMembershipId === undefined) return;

  await tx
    .insert(moduleOwnerships)
    .values(
      eligibleKeys.map((moduleKey) => ({
        orgId,
        moduleKey,
        ownerMembershipId,
      })),
    )
    .onConflictDoNothing();
}
