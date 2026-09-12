import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, notInArray, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  accountOrganizationIndex,
  organizationMembers,
  organizations,
} from "../../../db/schema";
import { withIdentity } from "../../../common/tenant/with-identity";
import { logger } from "../../../common/logger/logger.service";
import { forEachOrg, type ForEachOrgResult } from "../../../common/tenant/for-each-org";
import { LEGACY_CELL_ID } from "../../../common/region/placement";
import {
  getRegionRegistry,
  hasRegionRegistry,
} from "../../../common/region/region-registry";

function resolveCellId(region: string | null): string {
  if (!region || !hasRegionRegistry()) return LEGACY_CELL_ID;
  try {
    return getRegionRegistry().cellFor(region);
  } catch (error) {
    logger.error("[account-org-index] unknown region; projecting the legacy cell", {
      region,
      error: error instanceof Error ? error.message : String(error),
    });
    return LEGACY_CELL_ID;
  }
}

export type DirectoryActivationOutcome =
  | { status: "activated" }
  | { status: "unprojected" }
  | { status: "failed"; reason: string };

@Injectable()
export class AccountOrganizationIndexService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listForUser(userId: string) {
    return withIdentity(this.db, userId, (tx) =>
      tx
        .select({
          id: accountOrganizationIndex.orgId,
          name: accountOrganizationIndex.organizationName,
          slug: accountOrganizationIndex.organizationSlug,
          role: accountOrganizationIndex.membershipRole,
          joinedAt: accountOrganizationIndex.joinedAt,
        })
        .from(accountOrganizationIndex)
        .where(
          and(
            eq(accountOrganizationIndex.userId, userId),
            eq(accountOrganizationIndex.membershipStatus, "ACTIVE"),
            eq(accountOrganizationIndex.organizationStatus, "ACTIVE"),
          ),
        )
        .orderBy(desc(accountOrganizationIndex.joinedAt))
        .limit(100),
    );
  }

  async resolvePreferredOrg(
    userId: string,
  ): Promise<{ orgId: string; cellId: string } | null> {
    const rows = await withIdentity(this.db, userId, (tx) =>
      tx
        .select({
          orgId: accountOrganizationIndex.orgId,
          cellId: accountOrganizationIndex.cellId,
        })
        .from(accountOrganizationIndex)
        .where(eq(accountOrganizationIndex.userId, userId))
        .orderBy(
          sql`${accountOrganizationIndex.lastActivatedAt} DESC NULLS LAST`,
          desc(accountOrganizationIndex.joinedAt),
        )
        .limit(1),
    );
    const row = rows[0];
    if (!row) return null;
    return { orgId: row.orgId, cellId: row.cellId };
  }

  // A zero-row update does not throw, so the old void signature read that silence as success.
  async touchLastActivated(userId: string, orgId: string): Promise<boolean> {
    const touched = await withIdentity(this.db, userId, (tx) =>
      tx
        .update(accountOrganizationIndex)
        .set({ lastActivatedAt: new Date() })
        .where(
          and(
            eq(accountOrganizationIndex.userId, userId),
            eq(accountOrganizationIndex.orgId, orgId),
          ),
        )
        .returning({ orgId: accountOrganizationIndex.orgId }),
    );
    return touched.length > 0;
  }

  // `resolvePreferredOrg` orders by `last_activated_at`, so a missed stamp resolves the session to
  // another org; the projection is written by a refresh pass, so a just-joined org may have no row.
  async activate(
    userId: string,
    orgId: string,
  ): Promise<DirectoryActivationOutcome> {
    try {
      if (await this.touchLastActivated(userId, orgId))
        return { status: "activated" };
      await this.refreshForUser(userId);
      if (await this.touchLastActivated(userId, orgId))
        return { status: "activated" };
      logger.error("[account-org-index] projection absent after refresh", { userId, orgId });
      return { status: "unprojected" };
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.error("[account-org-index] last-activated write failed", {
        userId,
        orgId,
        error: reason,
      });
      return { status: "failed", reason };
    }
  }

  async refreshForUser(userId: string): Promise<void> {
    await withIdentity(this.db, userId, async (tx) => {
      const live = await tx
        .select({
          orgId: organizations.id,
          organizationName: organizations.name,
          organizationSlug: organizations.slug,
          membershipRole: organizationMembers.role,
          membershipStatus: organizationMembers.status,
          organizationStatus: organizations.status,
          joinedAt: organizationMembers.joinedAt,
          region: organizations.region,
        })
        .from(organizationMembers)
        .innerJoin(
          organizations,
          eq(organizations.id, organizationMembers.orgId),
        )
        .where(eq(organizationMembers.userId, userId))
        .limit(100);

      if (live.length === 0) {
        await tx
          .delete(accountOrganizationIndex)
          .where(eq(accountOrganizationIndex.userId, userId));
        return;
      }

      await tx
        .insert(accountOrganizationIndex)
        .values(
          live.map((m) => ({
            userId,
            orgId: m.orgId,
            cellId: resolveCellId(m.region),
            region: m.region ?? "primary",
            organizationName: m.organizationName,
            organizationSlug: m.organizationSlug,
            membershipRole: m.membershipRole,
            membershipStatus: m.membershipStatus,
            organizationStatus: m.organizationStatus,
            joinedAt: m.joinedAt,
            projectedAt: new Date(),
          })),
        )
        .onConflictDoUpdate({
          target: [accountOrganizationIndex.userId, accountOrganizationIndex.orgId],
          set: {
            cellId: sql`excluded.cell_id`,
            region: sql`excluded.region`,
            organizationName: sql`excluded.organization_name`,
            organizationSlug: sql`excluded.organization_slug`,
            membershipRole: sql`excluded.membership_role`,
            membershipStatus: sql`excluded.membership_status`,
            organizationStatus: sql`excluded.organization_status`,
            joinedAt: sql`excluded.joined_at`,
            projectedAt: sql`excluded.projected_at`,
          },
        });


      await tx
        .delete(accountOrganizationIndex)
        .where(
          and(
            eq(accountOrganizationIndex.userId, userId),
            notInArray(
              accountOrganizationIndex.orgId,
              live.map((m) => m.orgId),
            ),
          ),
        );
    });
  }

  async rebuild(): Promise<ForEachOrgResult> {
    return forEachOrg(
      this.db,
      "account-org-index-rebuild",
      async (tx, orgId) => {
        const members = await tx
          .select({
            userId: organizationMembers.userId,
            membershipRole: organizationMembers.role,
            membershipStatus: organizationMembers.status,
            organizationStatus: organizations.status,
            joinedAt: organizationMembers.joinedAt,
            organizationName: organizations.name,
            organizationSlug: organizations.slug,
            region: organizations.region,
          })
          .from(organizationMembers)
          .innerJoin(
            organizations,
            eq(organizations.id, organizationMembers.orgId),
          )
          .where(eq(organizationMembers.orgId, orgId))
          .limit(10000);

        if (!members.length) return;

        const region = members[0]?.region ?? null;
        const cellId = resolveCellId(region);

        await tx
          .insert(accountOrganizationIndex)
          .values(
            members.map((m) => ({
              userId: m.userId,
              orgId,
              cellId,
              region: region ?? "primary",
              organizationName: m.organizationName,
              organizationSlug: m.organizationSlug,
              membershipRole: m.membershipRole,
              membershipStatus: m.membershipStatus,
              organizationStatus: m.organizationStatus,
              joinedAt: m.joinedAt,
              projectedAt: new Date(),
            })),
          )
          .onConflictDoUpdate({
            target: [accountOrganizationIndex.userId, accountOrganizationIndex.orgId],
            set: {
              cellId: sql`excluded.cell_id`,
              region: sql`excluded.region`,
              organizationName: sql`excluded.organization_name`,
              organizationSlug: sql`excluded.organization_slug`,
              membershipRole: sql`excluded.membership_role`,
              membershipStatus: sql`excluded.membership_status`,
              organizationStatus: sql`excluded.organization_status`,
              joinedAt: sql`excluded.joined_at`,
              projectedAt: sql`excluded.projected_at`,
            },
          });
      },
    );
  }
}
