import { userModuleAccess } from "../../db/schema";
import type { TenantTx } from "../../common/tenant/with-tenant";

export async function writeUserModuleAccessOverride(
  tx: TenantTx,
  orgId: string,
  membershipId: number,
  moduleKey: string,
  enabled: boolean,
  updatedBy: string,
): Promise<void> {
  await tx
    .insert(userModuleAccess)
    .values({
      orgId,
      organizationMembershipId: membershipId,
      moduleKey,
      enabled,
      updatedBy,
    })
    .onConflictDoUpdate({
      target: [
        userModuleAccess.orgId,
        userModuleAccess.organizationMembershipId,
        userModuleAccess.moduleKey,
      ],
      set: { enabled, updatedBy },
    });
}
