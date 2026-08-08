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
  isNotNull,
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

const LINKABLE_MEMBERSHIP_STATUSES = [
  "INVITED",
  "ACTIVE",
  "SUSPENDED",
] as const;
const PG_UNIQUE_VIOLATION = "23505";

type PersonRow = typeof organizationPeople.$inferSelect;

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

export type DirectoryPersonWithAccess = PersonRow & {
  accountAccess: DirectoryPersonAccountAccess;
};

type MemberIdentity = {
  membershipId: number;
  userId: string;
  email: string;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
};

type IdentitySelector = {
  memberUserId?: string | null;
  organizationMembershipId?: number | null;
  workEmail?: string | null;
  personalEmail?: string | null;
};

function normalizeEmail(email?: string | null): string | null {
  const normalized = email?.trim().toLowerCase();
  return normalized || null;
}

function effectiveEmail(input: {
  workEmail?: string | null;
  personalEmail?: string | null;
}): string | null {
  return normalizeEmail(input.workEmail) ?? normalizeEmail(input.personalEmail);
}

@Injectable()
export class DirectoryIdentityService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private async findMemberIdentity(
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

    const [identity] = await this.db
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

  private async findPersonForIdentity(
    organizationId: string,
    identity: MemberIdentity,
    lifecycle: "active" | "deleted" = "active",
  ): Promise<PersonRow | null> {
    const email = normalizeEmail(identity.email);
    const [person] = await this.db
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
            eq(
              organizationPeople.organizationMembershipId,
              identity.membershipId,
            ),
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

  private invitationAccess(invitation: {
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

  private assertCompatibleLink(person: PersonRow, identity: MemberIdentity) {
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

  async resolveLinkForPersonWrite(
    organizationId: string,
    selector: IdentitySelector,
    currentOrganizationPersonId?: string,
  ): Promise<{ userId: string; organizationMembershipId: number } | null> {
    const hasExplicitIdentity = Boolean(
      selector.memberUserId || selector.organizationMembershipId,
    );
    const identity = await this.findMemberIdentity(organizationId, selector);

    if (hasExplicitIdentity && !identity) {
      throw new BadRequestException(
        "Select a current member of this organization.",
      );
    }
    if (!identity) return null;

    const existing = await this.findPersonForIdentity(organizationId, identity);
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
    if (existing) this.assertCompatibleLink(existing, identity);

    return {
      userId: identity.userId,
      organizationMembershipId: identity.membershipId,
    };
  }

  async reconcilePersonIdentity(
    organizationId: string,
    person: PersonRow,
  ): Promise<PersonRow> {
    const identity = await this.findMemberIdentity(organizationId, {
      memberUserId: person.userId,
      organizationMembershipId: person.userId
        ? undefined
        : person.organizationMembershipId,
      workEmail: person.workEmail,
      personalEmail: person.personalEmail,
    });
    if (!identity) return person;

    this.assertCompatibleLink(person, identity);
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
  ): Promise<DirectoryPersonWithAccess> {
    const [withAccess] = await this.resolvePeopleAccess(organizationId, [
      person,
    ]);
    return withAccess!;
  }

  async resolvePeopleAccess(
    organizationId: string,
    people: PersonRow[],
  ): Promise<DirectoryPersonWithAccess[]> {
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
    const memberIdentities = memberMatch
      ? await this.db
          .select({
            membershipId: organizationMembers.id,
            userId: users.id,
            email: users.email,
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
        const member = membersByMembershipId.get(
          person.organizationMembershipId,
        );
        if (member && (!person.userId || member.userId === person.userId)) {
          return member;
        }
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
        return { ...person, accountAccess: { state: "MEMBER" } };

      const email = effectiveEmail(person);
      const invitation = email ? invitationsByEmail.get(email) : undefined;
      return {
        ...person,
        accountAccess: invitation
          ? this.invitationAccess(invitation)
          : { state: "NONE" },
      };
    });
  }

  async ensurePersonForMember(
    organizationId: string,
    memberUserId: string,
  ): Promise<PersonRow> {
    const identity = await this.findMemberIdentity(organizationId, {
      memberUserId,
    });
    if (!identity) {
      throw new NotFoundException(
        "This member is no longer available in the organization.",
      );
    }

    const existing = await this.findPersonForIdentity(organizationId, identity);
    if (existing) {
      this.assertCompatibleLink(existing, identity);
      return this.reconcilePersonIdentity(organizationId, existing);
    }

    const deleted = await this.findPersonForIdentity(
      organizationId,
      identity,
      "deleted",
    );
    if (deleted) {
      this.assertCompatibleLink(deleted, identity);
      try {
        const [restored] = await this.db
          .update(organizationPeople)
          .set({
            deletedAt: null,
            userId: identity.userId,
            organizationMembershipId: identity.membershipId,
          })
          .where(
            and(
              eq(
                organizationPeople.organizationPersonId,
                deleted.organizationPersonId,
              ),
              eq(organizationPeople.organizationId, organizationId),
              isNotNull(organizationPeople.deletedAt),
            ),
          )
          .returning();
        if (restored) return restored;
      } catch (error) {
        if (getPostgresErrorCode(error) !== PG_UNIQUE_VIOLATION) throw error;
        throw new ConflictException({
          code: "DIRECTORY_MEMBER_ALREADY_LINKED",
          message:
            "This member is already linked to another directory person record. Refresh and select that person instead.",
        });
      }
    }

    const fullNameParts =
      identity.name?.trim().split(/\s+/).filter(Boolean) ?? [];
    const firstName =
      identity.firstName?.trim() ||
      fullNameParts[0] ||
      identity.email.split("@")[0] ||
      "Member";
    const lastName =
      identity.lastName?.trim() || fullNameParts.slice(1).join(" ") || "";

    try {
      const [created] = await this.db
        .insert(organizationPeople)
        .values({
          organizationId,
          userId: identity.userId,
          organizationMembershipId: identity.membershipId,
          firstName,
          lastName,
          displayName: identity.name?.trim() || null,
          workEmail: normalizeEmail(identity.email),
          phone: identity.phone,
        })
        .returning();
      if (!created)
        throw new NotFoundException("Failed to create person record");
      return created;
    } catch (error) {
      if (getPostgresErrorCode(error) !== PG_UNIQUE_VIOLATION) throw error;
      const winner = await this.findPersonForIdentity(organizationId, identity);
      if (winner) {
        this.assertCompatibleLink(winner, identity);
        return this.reconcilePersonIdentity(organizationId, winner);
      }
      throw new ConflictException({
        code: "DIRECTORY_MEMBER_ALREADY_LINKED",
        message:
          "A directory person already uses this member or work email. Refresh and select that person instead.",
      });
    }
  }
}
