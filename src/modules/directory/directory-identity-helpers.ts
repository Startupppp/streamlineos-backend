import { ConflictException } from "@nestjs/common";
import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { type Db } from "../../db/drizzle.module";
import { invitations, organizationMembers, organizationPeople, users } from "../../db/schema";

export type DirectoryPersonAccountAccess =
  | { state: "MEMBER" }
  | {
      state: "INVITED";
      invitationId: string;
      invitationStatus: "PENDING" | "EXPIRED";
      email: string;
      role: string;
      expiresAt: Date;
    }
  | { state: "NONE" };

export type DirectoryPersonWithAccess =
  typeof organizationPeople.$inferSelect & {
    accountAccess: DirectoryPersonAccountAccess;
  };

export const LINKABLE_MEMBERSHIP_STATUSES = [
  "INVITED",
  "ACTIVE",
  "SUSPENDED",
] as const;

export const PG_UNIQUE_VIOLATION = "23505";

export type MemberIdentity = {
  membershipId: number;
  userId: string;
  email: string;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
};

export type IdentitySelector = {
  memberUserId?: string | null;
  organizationMembershipId?: number | null;
  workEmail?: string | null;
  personalEmail?: string | null;
};

export function normalizeEmail(email?: string | null): string | null {
  const normalized = email?.trim().toLowerCase();
  return normalized || null;
}

export function effectiveEmail(input: {
  workEmail?: string | null;
  personalEmail?: string | null;
}): string | null {
  return normalizeEmail(input.workEmail) ?? normalizeEmail(input.personalEmail);
}

export function assertCompatibleLink(
  person: typeof organizationPeople.$inferSelect,
  identity: MemberIdentity,
) {
  if (
    (person.userId && person.userId !== identity.userId) ||
    (person.organizationMembershipId &&
      person.organizationMembershipId !== identity.membershipId &&
      person.userId !== identity.userId)
  ) {
    throw new ConflictException({
      code: "DIRECTORY_PERSON_IDENTITY_CONFLICT",
      message:
        "This email belongs to a different linked directory person. Review the existing records before continuing.",
      details: { organizationPersonId: person.organizationPersonId },
    });
  }
}

export function invitationAccess(invitation: {
  id: string;
  email: string;
  role: string;
  status: typeof invitations.$inferSelect.status;
  expiresAt: Date;
}): DirectoryPersonAccountAccess {
  const isExpired =
    invitation.status === "EXPIRED" || invitation.expiresAt <= new Date();
  return {
    state: "INVITED",
    invitationId: invitation.id,
    invitationStatus: isExpired ? "EXPIRED" : "PENDING",
    email: invitation.email,
    role: invitation.role,
    expiresAt: invitation.expiresAt,
  };
}

export async function findMemberIdentity(
  db: Db,
  organizationId: string,
  selector: IdentitySelector,
): Promise<MemberIdentity | null> {
  const email = effectiveEmail(selector);
  const identityCondition = selector.organizationMembershipId
    ? eq(organizationMembers.id, selector.organizationMembershipId)
    : selector.memberUserId
      ? eq(organizationMembers.userId, selector.memberUserId)
      : email
        ? sql`lower(trim(${users.email})) = ${email}`
        : undefined;

  if (!identityCondition) return null;

  const [identity] = await db
    .select({
      membershipId: organizationMembers.id,
      userId: users.id,
      email: users.email,
      name: users.name,
      firstName: users.firstName,
      lastName: users.lastName,
      phone: users.phone,
    })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(
      and(
        eq(organizationMembers.orgId, organizationId),
        inArray(organizationMembers.status, LINKABLE_MEMBERSHIP_STATUSES),
        identityCondition,
        selector.memberUserId
          ? eq(users.id, selector.memberUserId)
          : undefined,
      ),
    )
    .limit(1);

  return identity ?? null;
}

export async function findPersonForIdentity(
  db: Db,
  organizationId: string,
  identity: MemberIdentity,
  lifecycle: "active" | "deleted" = "active",
): Promise<typeof organizationPeople.$inferSelect | null> {
  const email = normalizeEmail(identity.email);
  const [person] = await db
    .select()
    .from(organizationPeople)
    .where(
      and(
        eq(organizationPeople.organizationId, organizationId),
        lifecycle === "active"
          ? isNull(organizationPeople.deletedAt)
          : isNotNull(organizationPeople.deletedAt),
        or(
          eq(organizationPeople.userId, identity.userId),
          eq(organizationPeople.organizationMembershipId, identity.membershipId),
          ...(email
            ? [
                sql`lower(trim(${organizationPeople.workEmail})) = ${email}`,
                and(
                  or(
                    isNull(organizationPeople.workEmail),
                    sql`trim(${organizationPeople.workEmail}) = ''`,
                  ),
                  sql`lower(trim(${organizationPeople.personalEmail})) = ${email}`,
                ),
              ]
            : []),
        ),
      ),
    )
    .limit(1);
  return person ?? null;
}
