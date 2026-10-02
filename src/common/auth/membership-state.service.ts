import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { organizationMembers, organizations, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { runInTenantTransaction } from "../tenant/run-in-tenant-transaction";
import { InProcessChannel } from "../rbac/access-version-channel";

export interface MembershipState {
  active: boolean;
  isOwner: boolean;
  role: string;
  membershipId: number | null;
}

export const MEMBERSHIP_STATE_TTL_MS = 1_000;
const SWEEP_THRESHOLD = 2_000;

const UNKNOWN: MembershipState = {
  active: false,
  isOwner: false,
  role: "",
  membershipId: null,
};

export const membershipStandingChannel = new InProcessChannel();

interface Entry<T> {
  value: T;
  expiresAt: number;
}

class LocalExpiringCache<T> {
  private readonly entries = new Map<string, Map<string, Entry<T>>>();
  private readonly inFlight = new Map<string, Promise<T>>();
  private size = 0;
  private generation = 0;

  async read(userId: string, scope: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(userId)?.get(scope);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    const flightKey = `${userId}\u0000${scope}`;
    const pending = this.inFlight.get(flightKey);
    if (pending) return pending;
    const startedAt = this.generation;
    const flight: Promise<T> = load()
      .then((value) => {
        if (startedAt === this.generation) this.store(userId, scope, value);
        return value;
      })
      .finally(() => {
        if (this.inFlight.get(flightKey) === flight) this.inFlight.delete(flightKey);
      });
    this.inFlight.set(flightKey, flight);
    return flight;
  }

  forgetUser(userId: string): void {
    this.generation += 1;
    this.size -= this.entries.get(userId)?.size ?? 0;
    this.entries.delete(userId);
    for (const key of this.inFlight.keys())
      if (key.startsWith(`${userId}\u0000`)) this.inFlight.delete(key);
  }

  private store(userId: string, scope: string, value: T): void {
    let byScope = this.entries.get(userId);
    if (!byScope) {
      byScope = new Map();
      this.entries.set(userId, byScope);
    }
    if (!byScope.has(scope)) this.size += 1;
    byScope.set(scope, { value, expiresAt: Date.now() + MEMBERSHIP_STATE_TTL_MS });
    if (this.size > SWEEP_THRESHOLD) this.sweep();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [userId, byScope] of this.entries) {
      for (const [scope, entry] of byScope) {
        if (entry.expiresAt > now) continue;
        byScope.delete(scope);
        this.size -= 1;
      }
      if (byScope.size === 0) this.entries.delete(userId);
    }
  }
}

const ACCOUNT_SCOPE = "account";

@Injectable()
export class MembershipStateService implements OnModuleInit, OnModuleDestroy {
  private readonly states = new LocalExpiringCache<MembershipState>();
  private readonly accounts = new LocalExpiringCache<boolean>();
  private unsubscribe: (() => void) | null = null;

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  onModuleInit(): void {
    this.unsubscribe = membershipStandingChannel.subscribe((userId) => this.forgetUser(userId));
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private forgetUser(userId: string): void {
    this.states.forgetUser(userId);
    this.accounts.forgetUser(userId);
  }

  async resolve(userId: string, orgId: string): Promise<MembershipState> {
    return this.states.read(userId, orgId, () => this.fetchMembershipState(userId, orgId));
  }

  private async fetchMembershipState(userId: string, orgId: string): Promise<MembershipState> {
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
    if (!row) return UNKNOWN;
    return {
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

  async isAccountActive(userId: string): Promise<boolean> {
    try {
      return await this.accounts.read(userId, ACCOUNT_SCOPE, () => this.fetchAccountActive(userId));
    } catch {
      return false;
    }
  }

  private async fetchAccountActive(userId: string): Promise<boolean> {
    const rows = await this.db
      .select({ isActive: users.isActive, deletedAt: users.deletedAt })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const row = rows[0];
    return row !== undefined && row.isActive && row.deletedAt === null;
  }
}
