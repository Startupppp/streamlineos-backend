import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { organizationMembers, organizations } from "../../../db/schema";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import {
  getRegionRegistry,
  hasRegionRegistry,
} from "../../../common/region/region-registry";

export interface OrganizationIdentity {
  id: string;
  name: string;
  slug: string;
}

function databaseForRegion(db: Db, region: string): Db {
  if (!hasRegionRegistry()) return db;
  return getRegionRegistry().bindingFor(region).db;
}

export function loadActiveOrganization(
  db: Db,
  orgId: string,
  region: string,
): Promise<OrganizationIdentity | null> {
  return runInNewTenantTransaction(
    databaseForRegion(db, region),
    orgId,
    async (tx) => {
      const organization = await tx.query.organizations.findFirst({
        where: and(
          eq(organizations.id, orgId),
          eq(organizations.status, "ACTIVE"),
          isNull(organizations.deletedAt),
        ),
        columns: { id: true, name: true, slug: true },
      });
      return organization ?? null;
    },
  );
}

export function organizationRowExists(
  db: Db,
  orgId: string,
  region: string,
): Promise<boolean> {
  return runInNewTenantTransaction(
    databaseForRegion(db, region),
    orgId,
    async (tx) => {
      const organization = await tx.query.organizations.findFirst({
        where: eq(organizations.id, orgId),
        columns: { id: true },
      });
      return organization != null;
    },
  );
}

export function setupOrganizationIsReusable(
  db: Db,
  orgId: string,
  region: string,
  userId: string,
): Promise<boolean> {
  return runInNewTenantTransaction(
    databaseForRegion(db, region),
    orgId,
    async (tx) => {
      const [organization, membership] = await Promise.all([
        tx.query.organizations.findFirst({
          where: and(
            eq(organizations.id, orgId),
            eq(organizations.status, "ACTIVE"),
            isNull(organizations.deletedAt),
          ),
          columns: { id: true },
        }),
        tx.query.organizationMembers.findFirst({
          where: and(
            eq(organizationMembers.orgId, orgId),
            eq(organizationMembers.userId, userId),
            eq(organizationMembers.status, "ACTIVE"),
            eq(organizationMembers.isOwner, true),
          ),
          columns: { id: true },
        }),
      ]);
      return organization != null && membership != null;
    },
  );
}
