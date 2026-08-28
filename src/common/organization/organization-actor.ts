import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { organizationMembers, organizationPeople } from "../../db/schema";
import type { DbOrTx } from "../rbac/access-invalidate";

export type OrganizationActorRef =
  | { kind: "user"; userId: string }
  | { kind: "membership"; membershipId: number }
  | { kind: "person"; organizationPersonId: string };

export type OrganizationActorFailure =
  | "no-membership"
  | "membership-inactive"
  | "membership-in-another-organization"
  | "ambiguous-membership";

export interface OrganizationActor {
  orgId: string;
  membershipId: number;
  userId: string;
  organizationPersonId: string | null;
  role: string;
  isOwner: boolean;
  resolvedVia: OrganizationActorRef["kind"];
}

export type OrganizationActorResolution =
  | { status: "resolved"; actor: OrganizationActor }
  | {
      status: "unresolved";
      orgId: string;
      ref: OrganizationActorRef;
      reason: OrganizationActorFailure;
    };

export function organizationActorRefKey(ref: OrganizationActorRef): string {
  if (ref.kind === "user") return `user:${ref.userId}`;
  if (ref.kind === "membership") return `membership:${ref.membershipId}`;
  return `person:${ref.organizationPersonId}`;
}

export class OrganizationActorError extends Error {
  readonly code = "ORGANIZATION_ACTOR_UNRESOLVED";

  constructor(
    readonly orgId: string,
    readonly ref: OrganizationActorRef,
    readonly reason: OrganizationActorFailure,
  ) {
    super(
      `Organization actor ${organizationActorRefKey(ref)} is unresolved in ${orgId}: ${reason}`,
    );
    this.name = "OrganizationActorError";
  }

  toAuditMetadata(): Record<string, string> {
    return {
      code: this.code,
      orgId: this.orgId,
      ref: organizationActorRefKey(this.ref),
      reason: this.reason,
    };
  }
}

export function organizationActorHttpError(
  error: OrganizationActorError,
): NotFoundException | ForbiddenException {
  if (error.reason === "membership-inactive") {
    return new ForbiddenException({
      code: error.code,
      reason: error.reason,
      message: "That membership is not active in this organization.",
    });
  }
  return new NotFoundException({
    code: error.code,
    reason: error.reason,
    message: "No such member of this organization.",
  });
}

const MEMBERSHIP_COLUMNS = {
  id: organizationMembers.id,
  orgId: organizationMembers.orgId,
  userId: organizationMembers.userId,
  role: organizationMembers.role,
  isOwner: organizationMembers.isOwner,
  status: organizationMembers.status,
};

function unresolved(
  orgId: string,
  ref: OrganizationActorRef,
  reason: OrganizationActorFailure,
): OrganizationActorResolution {
  return { status: "unresolved", orgId, ref, reason };
}

async function personIdOfMembership(
  db: DbOrTx,
  orgId: string,
  membershipId: number,
): Promise<string | null> {
  const [row] = await db
    .select({ id: organizationPeople.organizationPersonId })
    .from(organizationPeople)
    .where(
      and(
        eq(organizationPeople.organizationId, orgId),
        eq(organizationPeople.organizationMembershipId, membershipId),
        isNull(organizationPeople.deletedAt),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

async function membershipByUser(db: DbOrTx, orgId: string, userId: string) {
  const [row] = await db
    .select(MEMBERSHIP_COLUMNS)
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, userId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function membershipById(
  db: DbOrTx,
  orgId: string,
  membershipId: number,
) {
  const [row] = await db
    .select(MEMBERSHIP_COLUMNS)
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.id, membershipId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function membershipExistsElsewhere(
  db: DbOrTx,
  membershipId: number,
): Promise<boolean> {
  const [row] = await db
    .select({ id: organizationMembers.id })
    .from(organizationMembers)
    .where(eq(organizationMembers.id, membershipId))
    .limit(1);
  return row !== undefined;
}

type MembershipRow = {
  id: number;
  orgId: string;
  userId: string;
  role: string;
  isOwner: boolean;
  status: string;
};

function toActor(
  membership: MembershipRow,
  organizationPersonId: string | null,
  resolvedVia: OrganizationActorRef["kind"],
): OrganizationActor {
  return {
    orgId: membership.orgId,
    membershipId: membership.id,
    userId: membership.userId,
    organizationPersonId,
    role: membership.role,
    isOwner: membership.isOwner,
    resolvedVia,
  };
}

export async function resolveOrganizationActor(
  db: DbOrTx,
  orgId: string,
  ref: OrganizationActorRef,
): Promise<OrganizationActorResolution> {
  if (ref.kind === "person") return resolveByPerson(db, orgId, ref);

  const membership =
    ref.kind === "user"
      ? await membershipByUser(db, orgId, ref.userId)
      : await membershipById(db, orgId, ref.membershipId);

  if (!membership) {
    if (ref.kind === "membership" && (await membershipExistsElsewhere(db, ref.membershipId)))
      return unresolved(orgId, ref, "membership-in-another-organization");
    return unresolved(orgId, ref, "no-membership");
  }
  if (membership.status !== "ACTIVE")
    return unresolved(orgId, ref, "membership-inactive");

  const personId = await personIdOfMembership(db, orgId, membership.id);
  return {
    status: "resolved",
    actor: toActor(membership, personId, ref.kind),
  };
}

async function resolveByPerson(
  db: DbOrTx,
  orgId: string,
  ref: Extract<OrganizationActorRef, { kind: "person" }>,
): Promise<OrganizationActorResolution> {
  const [person] = await db
    .select({
      organizationPersonId: organizationPeople.organizationPersonId,
      organizationId: organizationPeople.organizationId,
      membershipId: organizationPeople.organizationMembershipId,
      userId: organizationPeople.userId,
    })
    .from(organizationPeople)
    .where(
      and(
        eq(organizationPeople.organizationId, orgId),
        eq(
          organizationPeople.organizationPersonId,
          ref.organizationPersonId,
        ),
        isNull(organizationPeople.deletedAt),
      ),
    )
    .limit(1);

  if (!person) return unresolved(orgId, ref, "no-membership");

  if (person.membershipId === null) {
    if (person.userId === null) return unresolved(orgId, ref, "no-membership");
    const byUser = await membershipByUser(db, orgId, person.userId);
    if (!byUser) return unresolved(orgId, ref, "no-membership");
    return unresolved(orgId, ref, "ambiguous-membership");
  }

  const membership = await membershipById(db, orgId, person.membershipId);
  if (!membership) {
    if (await membershipExistsElsewhere(db, person.membershipId))
      return unresolved(orgId, ref, "membership-in-another-organization");
    return unresolved(orgId, ref, "no-membership");
  }
  if (person.userId !== null && person.userId !== membership.userId)
    return unresolved(orgId, ref, "ambiguous-membership");
  if (membership.status !== "ACTIVE")
    return unresolved(orgId, ref, "membership-inactive");

  return {
    status: "resolved",
    actor: toActor(membership, person.organizationPersonId, "person"),
  };
}

export async function assertOrganizationActor(
  db: DbOrTx,
  orgId: string,
  ref: OrganizationActorRef,
): Promise<OrganizationActor> {
  const resolution = await resolveOrganizationActor(db, orgId, ref);
  if (resolution.status === "resolved") return resolution.actor;
  throw new OrganizationActorError(orgId, ref, resolution.reason);
}

export async function resolveOrganizationActorsByUserIds(
  db: DbOrTx,
  orgId: string,
  userIds: readonly string[],
): Promise<Map<string, OrganizationActor>> {
  const actors = new Map<string, OrganizationActor>();
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return actors;

  const memberships = await db
    .select(MEMBERSHIP_COLUMNS)
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.orgId, orgId),
        inArray(organizationMembers.userId, unique),
        eq(organizationMembers.status, "ACTIVE"),
      ),
    );
  if (memberships.length === 0) return actors;

  const people = await db
    .select({
      membershipId: organizationPeople.organizationMembershipId,
      organizationPersonId: organizationPeople.organizationPersonId,
    })
    .from(organizationPeople)
    .where(
      and(
        eq(organizationPeople.organizationId, orgId),
        inArray(
          organizationPeople.organizationMembershipId,
          memberships.map((row) => row.id),
        ),
        isNull(organizationPeople.deletedAt),
      ),
    );
  const personByMembership = new Map<number, string>();
  for (const row of people) {
    if (row.membershipId === null) continue;
    personByMembership.set(row.membershipId, row.organizationPersonId);
  }

  for (const membership of memberships) {
    actors.set(
      membership.userId,
      toActor(
        membership,
        personByMembership.get(membership.id) ?? null,
        "user",
      ),
    );
  }
  return actors;
}

export function legacyUserIdOf(actor: OrganizationActor): string {
  return actor.userId;
}
