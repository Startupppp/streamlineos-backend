import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, count, desc, eq, gt, ilike, inArray, isNull, or } from "drizzle-orm";
import { organizations, organizationMembers, invitations, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import type { CreateOrganizationInput, ListMembersInput } from "./dto/organization.schemas";

@Injectable()
export class OrganizationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async listUserOrganizations(userId: string) {
    const memberships = await this.db
      .select({
        orgId: organizationMembers.orgId,
        role: organizationMembers.role,
        joinedAt: organizationMembers.joinedAt,
      })
      .from(organizationMembers)
      .where(eq(organizationMembers.userId, userId))
      .orderBy(desc(organizationMembers.joinedAt));

    if (memberships.length === 0) return [];

    const orgIds = memberships.map((m) => m.orgId);
    const orgs = await this.db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        logo: organizations.logo,
      })
      .from(organizations)
      .where(inArray(organizations.id, orgIds));

    const orgMap = new Map(orgs.map((o) => [o.id, o]));

    return memberships.map((m) => {
      const org = orgMap.get(m.orgId);
      return {
        id: org?.id ?? m.orgId,
        name: org?.name ?? "Unknown",
        slug: org?.slug ?? "",
        role: m.role,
        joinedAt: m.joinedAt,
      };
    });
  }

  async createOrganization(userId: string, input: CreateOrganizationInput) {
    const [existing] = await this.db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, input.slug))
      .limit(1);

    if (existing) throw new ConflictException("Organization slug already exists");

    const orgId = randomUUID();

    await this.db.transaction(async (tx) => {
      await tx.insert(organizations).values({ id: orgId, name: input.name, slug: input.slug });
      await tx.insert(organizationMembers).values({ userId, orgId, role: "CEO" });
    });

    return { id: orgId, name: input.name, slug: input.slug };
  }

  async getProfile(userId: string, orgId: string) {
    const [user] = await this.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        image: users.image,
        role: users.role,
      })
      .from(users)
      .where(eq(users.id, userId));

    if (!user) return null;

    const [organization] = await this.db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        logo: organizations.logo,
      })
      .from(organizations)
      .where(eq(organizations.id, orgId));

    const [membership] = await this.db
      .select({
        role: organizationMembers.role,
        joinedAt: organizationMembers.joinedAt,
      })
      .from(organizationMembers)
      .where(
        and(eq(organizationMembers.userId, userId), eq(organizationMembers.orgId, orgId)),
      );

    return {
      user,
      organization: organization ?? null,
      membership: membership ?? null,
    };
  }

  async listMembers(orgId: string, { page, limit, search }: ListMembersInput) {
    const offset = (page - 1) * limit;
    const baseConditions = [eq(organizationMembers.orgId, orgId)];
    const searchConditions = search
      ? [
          ...baseConditions,
          or(ilike(users.name, `%${search}%`), ilike(users.email, `%${search}%`)),
        ]
      : baseConditions;

    const [dataResult, countResult] = await Promise.all([
      this.db
        .select({
          userId: organizationMembers.userId,
          role: organizationMembers.role,
          joinedAt: organizationMembers.joinedAt,
          name: users.name,
          email: users.email,
          image: users.image,
          totpEnabled: users.totpEnabled,
        })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .where(and(...searchConditions))
        .orderBy(users.name)
        .limit(limit)
        .offset(offset),
      this.db
        .select({ total: count() })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .where(and(...searchConditions)),
    ]);

    const total = countResult[0]?.total ?? 0;

    return {
      data: dataResult,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  listInvitations(orgId: string) {
    return this.db
      .select({
        id: invitations.id,
        email: invitations.email,
        role: invitations.role,
        expiresAt: invitations.expiresAt,
        createdAt: invitations.createdAt,
      })
      .from(invitations)
      .where(
        and(
          eq(invitations.orgId, orgId),
          isNull(invitations.acceptedAt),
          gt(invitations.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(invitations.createdAt));
  }

  async cancelInvitation(orgId: string, invitationId: string) {
    await this.db
      .delete(invitations)
      .where(and(eq(invitations.id, invitationId), eq(invitations.orgId, orgId)));
    return { success: true };
  }

  async removeMember(orgId: string, actorUserId: string, memberUserId: string) {
    await this.db
      .delete(organizationMembers)
      .where(
        and(
          eq(organizationMembers.userId, memberUserId),
          eq(organizationMembers.orgId, orgId),
        ),
      );

    this.audit.log({
      action: "org.member_removed",
      userId: actorUserId,
      orgId,
      targetId: memberUserId,
      targetType: "user",
    });

    return { success: true };
  }

  async getSettings(orgId: string) {
    const data = await this.db.query.organizations.findFirst({
      where: eq(organizations.id, orgId),
    });
    if (!data) return null;

    const settings: Record<string, unknown> = data.settings ?? {};
    return {
      ...data,
      primaryColor: typeof settings.primaryColor === "string" ? settings.primaryColor : null,
      loginBgUrl: typeof settings.loginBgUrl === "string" ? settings.loginBgUrl : null,
      ipAllowlist: Array.isArray(settings.ipAllowlist) ? settings.ipAllowlist : [],
      directoryPublic:
        typeof settings.directoryPublic === "boolean" ? settings.directoryPublic : false,
    };
  }
}
