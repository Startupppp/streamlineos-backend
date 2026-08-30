import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import {
  invitations,
  organizationMembers,
  organizationPeople,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { getPostgresErrorCode } from "../../common/db/postgres-error";
import {
  assertCompatibleLink,
  effectiveEmail,
  findMemberIdentity,
  findPersonForIdentity,
  invitationAccess,
  LINKABLE_MEMBERSHIP_STATUSES,
  normalizeEmail,
  PG_UNIQUE_VIOLATION,
  type IdentitySelector,
  type MemberIdentity,
} from "./directory-identity-helpers";

export type {
  DirectoryPersonAccountAccess,
  DirectoryPersonWithAccess,
} from "./directory-identity-helpers";

type PersonRow = typeof organizationPeople.$inferSelect;

@Injectable()
export class DirectoryIdentityService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async resolveLinkForPersonWrite(
    organizationId: string,
    selector: IdentitySelector,
    currentOrganizationPersonId?: string,
  ): Promise<{ userId: string; organizationMembershipId: number } | null> {
    const hasExplicitIdentity = Boolean(
      selector.memberUserId || selector.organizationMembershipId,
    );
    const identity = await findMemberIdentity(this.db, organizationId, selector);

    if (hasExplicitIdentity && !identity) {
      throw new BadRequestException(
        "Select a current member of this organization.",
      );
    }
    if (!identity) return null;

    const existing = await findPersonForIdentity(this.db, organizationId, identity);
    if (
      existing &&
      existing.organizationPersonId !== currentOrganizationPersonId
    ) {
      throw new ConflictException({
        code: "DIRECTORY_MEMBER_ALREADY_LINKED",
        message: "This member already has a directory person record.",
        details: { organizationPersonId: existing.organizationPersonId },
      });
    }
    if (existing) assertCompatibleLink(existing, identity);

    return {
      userId: identity.userId,
      organizationMembershipId: identity.membershipId,
    };
  }

  async reconcilePersonIdentity(
    organizationId: string,
    person: PersonRow,
  ): Promise<PersonRow> {
    const identity = await findMemberIdentity(this.db, organizationId, {
      memberUserId: person.userId,
      organizationMembershipId: person.userId
        ? undefined
        : person.organizationMembershipId,
      workEmail: person.workEmail,
      personalEmail: person.personalEmail,
    });
    if (!identity) return person;

    assertCompatibleLink(person, identity);
    if (
      person.userId === identity.userId &&
      person.organizationMembershipId === identity.membershipId
    ) {
      return person;
    }
    try {
      const [updated] = await this.db
        .update(organizationPeople)
        .set({
          userId: identity.userId,
          organizationMembershipId: identity.membershipId,
        })
        .where(
          and(
            eq(
              organizationPeople.organizationPersonId,
              person.organizationPersonId,
            ),
            eq(organizationPeople.organizationId, organizationId),
            isNull(organizationPeople.deletedAt),
          ),
        )
        .returning();
      return (
        updated ?? {
          ...person,
          userId: identity.userId,
          organizationMembershipId: identity.membershipId,
        }
      );
    } catch (error) {
      if (getPostgresErrorCode(error) !== PG_UNIQUE_VIOLATION) throw error;
      throw new ConflictException({
        code: "DIRECTORY_MEMBER_ALREADY_LINKED",
        message:
          "This member is already linked to another directory person record.",
        details: { organizationPersonId: person.organizationPersonId },
      });
    }
  }

  async resolvePersonAccess(
    organizationId: string,
    person: PersonRow,
  ) {
    const [withAccess] = await this.resolvePeopleAccess(organizationId, [person]);
    if (!withAccess) throw new Error("Failed to resolve person access");
    return withAccess;
  }

  async resolvePeopleAccess(
    organizationId: string,
    people: PersonRow[],
  ) {
    if (people.length === 0) return [];

    const membershipIds = Array.from(
      new Set(
        people
          .map((person) => person.organizationMembershipId)
          .filter((id): id is number => id !== null),
      ),
    );
    const userIds = Array.from(
      new Set(
        people
          .map((person) => person.userId)
          .filter((id): id is string => Boolean(id)),
      ),
    );
    const memberEmails = Array.from(
      new Set(
        people
          .filter(
            (person) => !person.userId && !person.organizationMembershipId,
          )
          .map(effectiveEmail)
          .filter((email): email is string => Boolean(email)),
      ),
    );
    const memberMatch = or(
      membershipIds.length > 0
        ? inArray(organizationMembers.id, membershipIds)
        : undefined,
      userIds.length > 0
        ? inArray(organizationMembers.userId, userIds)
        : undefined,
      memberEmails.length > 0
        ? inArray(sql<string>`lower(trim(${users.email}))`, memberEmails)
        : undefined,
    );
    const memberIdentities: MemberIdentity[] = memberMatch
      ? await this.db
          .select({
            membershipId: organizationMembers.id,
            userId: users.id,
            email: users.email,
            name: users.name as unknown as string | null,
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
              memberMatch,
            ),
          )
      : [];

    const membersByMembershipId = new Map(
      memberIdentities.map((member) => [member.membershipId, member]),
    );
    const membersByUserId = new Map(
      memberIdentities.map((member) => [member.userId, member]),
    );
    const membersByEmail = new Map(
      memberIdentities.map((member) => [normalizeEmail(member.email)!, member]),
    );
    const matchedMembers = people.map((person) => {
      if (person.organizationMembershipId !== null) {
        const member = membersByMembershipId.get(person.organizationMembershipId);
        if (member && (!person.userId || member.userId === person.userId))
          return member;
      }
      if (person.userId) return membersByUserId.get(person.userId) ?? null;
      const email = effectiveEmail(person);
      return email ? (membersByEmail.get(email) ?? null) : null;
    });

    const emails = Array.from(
      new Set(
        people
          .filter((_person, index) => !matchedMembers[index])
          .map(effectiveEmail)
          .filter((email): email is string => Boolean(email)),
      ),
    );

    const openInvitations =
      emails.length === 0
        ? []
        : await this.db
            .select({
              id: invitations.id,
              email: invitations.email,
              role: invitations.role,
              status: invitations.status,
              expiresAt: invitations.expiresAt,
            })
            .from(invitations)
            .where(
              and(
                eq(invitations.orgId, organizationId),
                inArray(invitations.status, ["PENDING", "EXPIRED"]),
                isNull(invitations.acceptedAt),
                inArray(sql<string>`lower(trim(${invitations.email}))`, emails),
              ),
            )
            .orderBy(desc(invitations.createdAt));

    const invitationsByEmail = new Map<
      string,
      (typeof openInvitations)[number]
    >();
    for (const invitation of openInvitations) {
      const email = normalizeEmail(invitation.email)!;
      if (!invitationsByEmail.has(email))
        invitationsByEmail.set(email, invitation);
    }

    return people.map((person, index) => {
      if (matchedMembers[index])
        return { ...person, accountAccess: { state: "MEMBER" as const } };

      const email = effectiveEmail(person);
      const invitation = email ? invitationsByEmail.get(email) : undefined;
      return {
        ...person,
        accountAccess: invitation
          ? invitationAccess(invitation)
          : { state: "NONE" as const },
      };
    });
  }
}
