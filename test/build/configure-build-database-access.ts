import type { INestApplication } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { MembershipStateService } from "src/common/auth/membership-state.service";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import type { Db } from "src/db/drizzle.types";
import { organizationMembers } from "src/db/schema";
import { AccessService } from "src/modules/access/access.service";

export function configureBuildDatabaseAccess(app: INestApplication, db: Db): void {
  const access = app.get(AccessService);
  jest.spyOn(access, "holds").mockImplementation(async (actor, key) =>
    actor.isOrgOwner || (await access.resolveUserPermissions(actor.orgId, actor.userId)).has(key));
  jest.spyOn(access, "scopeFor").mockImplementation(async (actor, key) =>
    actor.isOrgOwner ? "all" : (await access.resolveUserPermissions(actor.orgId, actor.userId)).get(key) ?? "none");
  jest.spyOn(app.get(MembershipStateService), "resolve").mockImplementation(async (userId, orgId) =>
    runInNewTenantTransaction(db, orgId, async tx => {
      const row = await tx.query.organizationMembers.findFirst({
        where: and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)),
        columns: { id: true, status: true, isOwner: true, role: true },
      });
      return { active: row?.status === "ACTIVE", isOwner: row?.isOwner ?? false,
        role: row?.role ?? "", membershipId: row?.id ?? null };
    }));
}
