import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { organizationMembers, organizations, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { runInTenantTransaction } from "../tenant/run-in-tenant-transaction";
import { CacheService } from "../cache/cache.service";
import { CACHE_KEYS } from "../cache/cache-keys";

export interface MembershipState {
  active: boolean;
  isOwner: boolean;
  role: string;
  membershipId: number | null;
}

const MEMBERSHIP_STATUS_TTL_SECONDS = 15;

const UNKNOWN: MembershipState = {
  active: false,
  isOwner: false,
  role: "",
  membershipId: null,
};

export async function bustMembershipStatusCache(
  cache: CacheService,
  userId: string,
  _orgId?: string,
): Promise<void> {
  await cache.invalidate(CACHE_KEYS.membershipAccount(userId));
  // One user namespace supports both targeted and all-organization busts in
  // constant time. A targeted bust intentionally expires the user's other
  // short-lived membership entries too; membership changes are rare and this
  // avoids maintaining per-org generation counters.
  await cache.invalidateNamespace(`membership:status:${userId}`);
}

@Injectable()
export class MembershipStateService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async resolve(userId: string, orgId: string): Promise<MembershipState> {
    return this.cache.cachedVersioned(
      `membership:status:${userId}`,
      orgId,
      () => this.fetchMembershipState(userId, orgId),
      MEMBERSHIP_STATUS_TTL_SECONDS,
    );
  }

  private async fetchMembershipState(userId: string, orgId: string): Promise<MembershipState> {
    let state = UNKNOWN;
    try {
      const rows = await runInTenantTransaction(
        this.db,
        (tx) =>
          tx
            .select({
              membershipId: organizationMembers.id,
              status: organizationMembers.status,
              isOwner: organizationMembers.isOwner,
              role: organizationMembers.role,
              userIsActive: users.isActive,
              userDeletedAt: users.deletedAt,
              orgStatus: organizations.status,
              orgDeletedAt: organizations.deletedAt,
            })
            .from(organizationMembers)
            .innerJoin(users, eq(users.id, organizationMembers.userId))
            .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
            .where(
              and(
                eq(organizationMembers.userId, userId),
                eq(organizationMembers.orgId, orgId),
              ),
            )
            .orderBy(desc(organizationMembers.joinedAt))
            .limit(1),
        { orgId },
      );
      const row = rows[0];
      if (row) {
        state = {
          active:
            row.status === "ACTIVE" &&
            row.userIsActive &&
            row.userDeletedAt === null &&
            row.orgStatus === "ACTIVE" &&
            row.orgDeletedAt === null,
          isOwner: row.isOwner,
          role: row.role,
          membershipId: row.membershipId,
        };
      }
    } catch {
      state = UNKNOWN;
    }

    return state;
  }

  async isAccountActive(userId: string): Promise<boolean> {
    const key = CACHE_KEYS.membershipAccount(userId);
    const cached = await this.cache.get<MembershipState>(key);
    if (cached) return cached.active;

    let active = false;
    try {
      const rows = await this.db
        .select({ isActive: users.isActive, deletedAt: users.deletedAt })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      const row = rows[0];
      if (row) active = row.isActive && row.deletedAt === null;
    } catch {
      active = false;
    }

    await this.cache.set(
      key,
      { ...UNKNOWN, active },
      MEMBERSHIP_STATUS_TTL_SECONDS,
    );
    return active;
  }
}
