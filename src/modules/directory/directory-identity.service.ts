import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  invitations,
  organizationMembers,
  organizationPeople,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";

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
};

function normalizeEmail(email?: string | null): string | null {
  const normalized = email?.trim().toLowerCase();
  return normalized || null;
}

function postgresCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

@Injectable()
export class DirectoryIdentityService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private async findMemberIdentity(
    organizationId: string,
    selector: IdentitySelector,
  ): Promise<MemberIdentity | null> {
    const email = normalizeEmail(selector.workEmail);
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
  ): Promise<PersonRow | null> {
    const email = normalizeEmail(identity.email)!;
    const [person] = await this.db
      .select()
      .from(organizationPeople)
      .where(
        and(
          eq(organizationPeople.organizationId, organizationId),
          isNull(organizationPeople.deletedAt),
          or(
            eq(organizationPeople.userId, identity.userId),
            eq(
              organizationPeople.organizationMembershipId,
              identity.membershipId,
            ),
            sql`lower(trim(${organizationPeople.workEmail})) = ${email}`,
          ),
        ),
      )
      .limit(1);
    return person ?? null;
  }

  private async findOpenInvitation(organizationId: string, person: PersonRow) {
    const emails = [
      normalizeEmail(person.workEmail),
      normalizeEmail(person.personalEmail),
    ].filter((email): email is string => Boolean(email));
    if (emails.length === 0) return null;

    const [invitation] = await this.db
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
      .orderBy(desc(invitations.createdAt))
      .limit(1);

    return invitation ?? null;
  }

  private async attachAccountAccess(
    organizationId: string,
    person: PersonRow,
  ): Promise<DirectoryPersonWithAccess> {
    if (person.userId || person.organizationMembershipId)
      return { ...person, accountAccess: { state: "MEMBER" } };

    const invitation = await this.findOpenInvitation(organizationId, person);
    if (!invitation) return { ...person, accountAccess: { state: "NONE" } };

    return {
      ...person,
      accountAccess: this.invitationAccess(invitation),
    };
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
        person.organizationMembershipId !== identity.membershipId)
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
    if (person.userId && person.organizationMembershipId) return person;

    const identity = await this.findMemberIdentity(organizationId, {
      memberUserId: person.userId,
      organizationMembershipId: person.organizationMembershipId,
      workEmail: person.workEmail,
    });
    if (!identity) return person;

    this.assertCompatibleLink(person, identity);
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
      if (postgresCode(error) !== PG_UNIQUE_VIOLATION) throw error;
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
    reconcileIdentity = false,
  ): Promise<DirectoryPersonWithAccess> {
    const resolvedPerson = reconcileIdentity
      ? await this.reconcilePersonIdentity(organizationId, person)
      : person;
    return this.attachAccountAccess(organizationId, resolvedPerson);
  }

  async resolvePeopleAccess(
    organizationId: string,
    people: PersonRow[],
  ): Promise<DirectoryPersonWithAccess[]> {
    const emails = Array.from(
      new Set(
        people
          .filter(
            (person) => !person.userId && !person.organizationMembershipId,
          )
          .flatMap((person) => [person.workEmail, person.personalEmail])
          .map(normalizeEmail)
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

    return people.map((person) => {
      if (person.userId || person.organizationMembershipId)
        return { ...person, accountAccess: { state: "MEMBER" } };

      const invitation = [person.workEmail, person.personalEmail]
        .map(normalizeEmail)
        .filter((email): email is string => Boolean(email))
        .map((email) => invitationsByEmail.get(email))
        .find((candidate) => candidate !== undefined);
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
      if (postgresCode(error) !== PG_UNIQUE_VIOLATION) throw error;
      throw new ConflictException({
        code: "DIRECTORY_MEMBER_ALREADY_LINKED",
        message:
          "A directory person already uses this member or work email. Refresh and select that person instead.",
      });
    }
  }
}
