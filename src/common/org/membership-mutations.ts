import { and, eq, inArray, sql } from "drizzle-orm";
import { organizationMembers } from "../../db/schema";
import type { CacheService } from "../cache/cache.service";
import { bumpPermissionsVersion, type DbOrTx } from "../rbac/access-invalidate";
import {
  syncStructuralRoleAssignment,
  syncStructuralRoleAssignments,
} from "../rbac/sync-structural-role";
import {
  scheduleMembershipBust,
  scheduleMembershipBustMany,
} from "./membership-bust";

// The one owner of organization_members writes: every op couples the write, its permission-version and structural-role effects, and the invalidation drained only after the caller's transaction resolves.

export type MembershipStatus = NonNullable<
  (typeof organizationMembers.$inferInsert)["status"]
>;

const DRAIN = Symbol("membership-mutations-drain");

function lifecycleColumns(
  status: MembershipStatus,
  occurredAt: Date,
): Partial<typeof organizationMembers.$inferInsert> {
  if (status === "ACTIVE")
    return { status, activatedAt: occurredAt, suspendedAt: null, leftAt: null };
  if (status === "SUSPENDED") return { status, suspendedAt: occurredAt, leftAt: null };
  if (status === "LEFT") return { status, leftAt: occurredAt, suspendedAt: null };
  return { status };
}

export class MembershipMutations {
  private readonly pending = new Map<string, string | undefined>();

  private record(userId: string, orgId?: string): void {
    if (!this.pending.has(userId)) this.pending.set(userId, orgId);
  }

  async [DRAIN](cache: CacheService): Promise<void> {
    if (this.pending.size === 0) return;
    const entries = [...this.pending];
    const first = entries[0];
    if (entries.length === 1 && first) {
      await scheduleMembershipBust(cache, first[0], first[1]);
      return;
    }
    await scheduleMembershipBustMany(
      cache,
      entries.map(([userId]) => userId),
    );
  }

  // organizations.owner_membership_id and organization_members.org_id point at each other, so a bootstrap needs the id first.
  async allocateMembershipId(tx: DbOrTx): Promise<number> {
    const rows = await tx.execute(
      sql`SELECT nextval(pg_get_serial_sequence('organization_members', 'id')) AS id`,
    );
    const membershipId = Number(rows[0]?.id);
    if (!Number.isInteger(membershipId))
      throw new Error("Failed to allocate owner membership id");
    return membershipId;
  }

  async createOwnerMembership(
    tx: DbOrTx,
    input: {
      orgId: string;
      userId: string;
      membershipId: number;
      role: string;
      activatedAt?: Date;
    },
  ): Promise<void> {
    await tx.insert(organizationMembers).values({
      id: input.membershipId,
      orgId: input.orgId,
      userId: input.userId,
      role: input.role,
      isOwner: true,
      status: "ACTIVE",
      ...(input.activatedAt ? { activatedAt: input.activatedAt } : {}),
    });
    this.record(input.userId, input.orgId);
  }

  async createMembership(
    tx: DbOrTx,
    input: {
      orgId: string;
      userId: string;
      role: string;
      onConflict?: "skip" | "fail";
    },
  ): Promise<number | null> {
    const values = { orgId: input.orgId, userId: input.userId, role: input.role };
    const inserted =
      input.onConflict === "skip"
        ? await tx
            .insert(organizationMembers)
            .values(values)
            .onConflictDoNothing()
            .returning({ id: organizationMembers.id })
        : await tx
            .insert(organizationMembers)
            .values(values)
            .returning({ id: organizationMembers.id });
    const membershipId = inserted[0]?.id;
    this.record(input.userId, input.orgId);
    if (membershipId === undefined) return null;
    await syncStructuralRoleAssignment(tx, input.orgId, membershipId, input.role);
    return membershipId;
  }

  async createMemberships(
    tx: DbOrTx,
    input: {
      orgId: string;
      members: readonly { userId: string; role: string }[];
    },
  ): Promise<Map<string, number>> {
    const byUserId = new Map<string, number>();
    if (input.members.length === 0) return byUserId;

    const inserted = await tx
      .insert(organizationMembers)
      .values(
        input.members.map((member) => ({
          orgId: input.orgId,
          userId: member.userId,
          role: member.role,
        })),
      )
      .returning({
        id: organizationMembers.id,
        userId: organizationMembers.userId,
      });
    for (const row of inserted) byUserId.set(row.userId, row.id);
    for (const member of input.members) this.record(member.userId, input.orgId);

    const membershipIdsByRole = new Map<string, number[]>();
    for (const member of input.members) {
      const membershipId = byUserId.get(member.userId);
      if (membershipId === undefined) continue;
      membershipIdsByRole.set(member.role, [
        ...(membershipIdsByRole.get(member.role) ?? []),
        membershipId,
      ]);
    }
    for (const [role, membershipIds] of membershipIdsByRole)
      await syncStructuralRoleAssignments(tx, input.orgId, membershipIds, role);

    return byUserId;
  }

  async changeRole(
    tx: DbOrTx,
    input: { orgId: string; userId: string; role: string },
  ): Promise<number | null> {
    const [member] = await tx
      .update(organizationMembers)
      .set({ role: input.role })
      .where(
        and(
          eq(organizationMembers.orgId, input.orgId),
          eq(organizationMembers.userId, input.userId),
        ),
      )
      .returning({ id: organizationMembers.id });
    this.record(input.userId, input.orgId);
    if (!member) return null;
    await syncStructuralRoleAssignment(tx, input.orgId, member.id, input.role);
    return member.id;
  }

  async changeRoles(
    tx: DbOrTx,
    input: { orgId: string; userIds: readonly string[]; role: string },
  ): Promise<number[]> {
    if (input.userIds.length === 0) return [];
    const rows = await tx
      .update(organizationMembers)
      .set({ role: input.role })
      .where(
        and(
          eq(organizationMembers.orgId, input.orgId),
          inArray(organizationMembers.userId, [...input.userIds]),
        ),
      )
      .returning({ id: organizationMembers.id });
    for (const userId of input.userIds) this.record(userId, input.orgId);
    const membershipIds = rows.map((row) => row.id);
    await syncStructuralRoleAssignments(tx, input.orgId, membershipIds, input.role);
    return membershipIds;
  }

  async setLifecycleStatus(
    tx: DbOrTx,
    input: {
      orgId: string;
      userId: string;
      status: MembershipStatus;
      occurredAt: Date;
    },
  ): Promise<void> {
    await tx
      .update(organizationMembers)
      .set(lifecycleColumns(input.status, input.occurredAt))
      .where(
        and(
          eq(organizationMembers.userId, input.userId),
          eq(organizationMembers.orgId, input.orgId),
        ),
      );
    await bumpPermissionsVersion(tx, input.orgId);
    this.record(input.userId, input.orgId);
  }

  async transferOrgOwnership(
    tx: DbOrTx,
    input: {
      orgId: string;
      from: { membershipId: number; userId: string };
      to: { membershipId: number; userId: string };
      demotedRole: string;
      ownerRole: string;
    },
  ): Promise<void> {
    await tx
      .update(organizationMembers)
      .set({ isOwner: false, role: input.demotedRole })
      .where(eq(organizationMembers.id, input.from.membershipId));
    await syncStructuralRoleAssignment(
      tx,
      input.orgId,
      input.from.membershipId,
      input.demotedRole,
    );
    await tx
      .update(organizationMembers)
      .set({ isOwner: true, role: input.ownerRole, status: "ACTIVE" })
      .where(eq(organizationMembers.id, input.to.membershipId));
    // Both sides of a transfer change role, so both structural assignments must follow it.
    await syncStructuralRoleAssignment(
      tx,
      input.orgId,
      input.to.membershipId,
      input.ownerRole,
    );
    this.record(input.from.userId, input.orgId);
    this.record(input.to.userId, input.orgId);
  }

  async deleteMembership(
    tx: DbOrTx,
    input: { orgId: string; userId: string },
  ): Promise<void> {
    await tx
      .delete(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, input.orgId),
          eq(organizationMembers.userId, input.userId),
        ),
      );
    await bumpPermissionsVersion(tx, input.orgId);
    this.record(input.userId, input.orgId);
  }

  async deleteMembershipsById(
    tx: DbOrTx,
    input: { orgId: string; userId: string; membershipIds: readonly number[] },
  ): Promise<void> {
    if (input.membershipIds.length === 0) return;
    await tx
      .delete(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, input.orgId),
          inArray(organizationMembers.id, [...input.membershipIds]),
        ),
      );
    this.record(input.userId, input.orgId);
  }
}

// `run` rejecting drains nothing, so a rolled-back membership change publishes no bust.
export async function withMembershipMutations<T>(
  cache: CacheService,
  run: (mutations: MembershipMutations) => Promise<T>,
): Promise<T> {
  const mutations = new MembershipMutations();
  const result = await run(mutations);
  await mutations[DRAIN](cache);
  return result;
}
