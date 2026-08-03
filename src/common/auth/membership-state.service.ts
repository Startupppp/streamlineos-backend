import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { organizationMembers, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { runInTenantTransaction } from "../tenant/run-in-tenant-transaction";

export interface MembershipState {
  active: boolean;
  isOwner: boolean;
  role: string;
}

interface CacheEntry {
  value: MembershipState;
  expiresAt: number;
}

const MEMBERSHIP_STATUS_TTL_MS = 15_000;
const membershipStatusCache = new Map<string, CacheEntry>();

const UNKNOWN: MembershipState = { active: false, isOwner: false, role: "" };

export function bustMembershipStatusCache(userId: string, orgId?: string): void {
  membershipStatusCache.delete(`${userId}:account`);
  if (orgId) {
    membershipStatusCache.delete(`${userId}:${orgId}`);
    return;
  }
  for (const key of Array.from(membershipStatusCache.keys())) {
    if (key.startsWith(`${userId}:`)) membershipStatusCache.delete(key);
  }
}

@Injectable()
export class MembershipStateService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async resolve(userId: string, orgId: string): Promise<MembershipState> {
    const key = `${userId}:${orgId}`;
    const cached = membershipStatusCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

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

    membershipStatusCache.set(key, {
      value: state,
      expiresAt: Date.now() + MEMBERSHIP_STATUS_TTL_MS,
    });
    return state;
  }

  async isAccountActive(userId: string): Promise<boolean> {
    const key = `${userId}:account`;
    const cached = membershipStatusCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value.active;

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

    membershipStatusCache.set(key, {
      value: { ...UNKNOWN, active },
      expiresAt: Date.now() + MEMBERSHIP_STATUS_TTL_MS,
    });
    return active;
  }
}
