import { BadRequestException } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { moduleOwnerships, organizationMembers } from "../../db/schema";
import type { DbOrTx } from "./access-invalidate";

const MESSAGE =
  "The organization owner's role cannot be changed. Use the ownership transfer flow instead.";

export type OwnerProtectedAction = "suspended" | "archived" | "deleted";

async function targetIsOwner(
  db: DbOrTx,
  orgId: string,
  targetUserId: string,
): Promise<boolean> {
  const [member] = await db
    .select({ isOwner: organizationMembers.isOwner })
    .from(organizationMembers)
    .where(
      and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, targetUserId)),
    )
    .limit(1);

  return member?.isOwner === true;
}

export async function assertTargetNotOwner(
  db: DbOrTx,
  orgId: string,
  targetUserId: string,
): Promise<void> {
  if (await targetIsOwner(db, orgId, targetUserId)) throw new BadRequestException(MESSAGE);
}

export async function assertOwnerNotTargeted(
  db: DbOrTx,
  orgId: string,
  targetUserId: string,
  action: OwnerProtectedAction,
): Promise<void> {
  if (await targetIsOwner(db, orgId, targetUserId)) {
    throw new BadRequestException(
      `The organization owner cannot be ${action}. Transfer ownership to another member first.`,
    );
  }
}

export async function assertNoOwnerAmongTargets(
  db: DbOrTx,
  orgId: string,
  targetUserIds: string[],
): Promise<void> {
  if (targetUserIds.length === 0) return;

  const owners = await db
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.isOwner, true),
        inArray(organizationMembers.userId, targetUserIds),
      ),
    )
    .limit(1);

  if (owners.length > 0) throw new BadRequestException(MESSAGE);
}

export async function assertNotModuleOwner(
  db: DbOrTx,
  orgId: string,
  ownerMembershipId: number,
): Promise<void> {
  const owned = await db
    .select({ moduleKey: moduleOwnerships.moduleKey })
    .from(moduleOwnerships)
    .where(
      and(
        eq(moduleOwnerships.orgId, orgId),
        eq(moduleOwnerships.ownerMembershipId, ownerMembershipId),
      ),
    );
  if (owned.length > 0) {
    throw new BadRequestException(
      `Transfer module ownership before this action. Owned modules: ${owned.map((r) => r.moduleKey).join(", ")}.`,
    );
  }
}
