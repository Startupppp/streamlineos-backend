import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { organizationMembers, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { runInTenantTransaction } from "../tenant/run-in-tenant-transaction";
import { CacheService } from "../cache/cache.service";
import { CACHE_KEYS } from "../cache/cache-keys";

export interface MembershipState {
  active: boolean;
  isOwner: boolean;
  role: string;
}

const MEMBERSHIP_STATUS_TTL_SECONDS = 15;

const UNKNOWN: MembershipState = { active: false, isOwner: false, role: "" };

export async function bustMembershipStatusCache(
  cache: CacheService,
  userId: string,
  orgId?: string,
): Promise<void> {
  await cache.invalidate(CACHE_KEYS.membershipAccount(userId));
  if (orgId) {
    await cache.invalidate(CACHE_KEYS.membershipStatus(userId, orgId));
    return;
  }
  await cache.invalidatePattern(CACHE_KEYS.membershipStatusPattern(userId));
}

@Injectable()
export class MembershipStateService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async resolve(userId: string, orgId: string): Promise<MembershipState> {
    const key = CACHE_KEYS.membershipStatus(userId, orgId);
    const cached = await this.cache.get<MembershipState>(key);
    if (cached) return cached;

    let state = UNKNOWN;
    try {
      const rows = await runInTenantTransaction(
        this.db,
        (tx) =>
          tx
            .select({
              status: organizationMembers.status,
              isOwner: organizationMembers.isOwner,
              role: organizationMembers.role,
              userIsActive: users.isActive,
              userDeletedAt: users.deletedAt,
            })
            .from(organizationMembers)
            .innerJoin(users, eq(users.id, organizationMembers.userId))
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
            row.userDeletedAt === null,
          isOwner: row.isOwner,
          role: row.role,
        };
      }
    } catch {
      state = UNKNOWN;
    }

    await this.cache.set(key, state, MEMBERSHIP_STATUS_TTL_SECONDS);
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
