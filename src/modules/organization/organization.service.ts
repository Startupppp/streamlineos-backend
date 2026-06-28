import { BadRequestException, ConflictException, Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, count, desc, eq, gt, ilike, inArray, isNull, or } from "drizzle-orm";
import { organizations, organizationMembers, invitations, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { EmailService } from "../email/email.service";
import type {
  CreateOrganizationInput,
  InviteMemberInput,
  ListMembersInput,
  SecuritySettingsInput,
  UpdateOrgSettingsInput,
} from "./dto/organization.schemas";


type SecuritySettingsUpdate = {
  mfaEnforced?: boolean;
  passwordExpiryDays?: number | null;
  allowedEmailDomains?: string[];
  maxConcurrentSessions?: number | null;
};

type OrgSettingsUpdate = {
  name?: string;
  slug?: string;
  logo?: string | null;
  timezone?: string;
  currency?: string;
  fiscalYearStart?: number;
  mfaEnforced?: boolean;
  allowedEmailDomains?: string[];
  settings?: Record<string, unknown>;
};

@Injectable()
export class OrganizationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly email: EmailService,
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

  async switchOrg(userId: string, targetOrgId: string) {
    const membership = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.orgId, targetOrgId),
      ),
      columns: { role: true },
    });
    if (!membership) throw new BadRequestException("You are not a member of this organization");

    const [org] = await this.db
      .select({ id: organizations.id, name: organizations.name, slug: organizations.slug })
      .from(organizations)
      .where(eq(organizations.id, targetOrgId))
      .limit(1);
    if (!org) throw new BadRequestException("Organization not found");

    await this.cache.invalidate(CACHE_KEYS.userSession(userId));

    this.audit.log({ action: "org.switched", userId, orgId: targetOrgId });

    return { orgId: org.id, name: org.name, slug: org.slug, role: membership.role };
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

  async updateSettings(orgId: string, actorUserId: string, input: UpdateOrgSettingsInput) {
    if (input.slug) {
      const existing = await this.db.query.organizations.findFirst({
        where: and(eq(organizations.slug, input.slug), eq(organizations.id, orgId)),
      });
      if (!existing) {
        const slugTaken = await this.db.query.organizations.findFirst({
          where: eq(organizations.slug, input.slug),
        });
        if (slugTaken) throw new ConflictException("Slug already in use");
      }
    }

    const updateData: OrgSettingsUpdate = {};

    if (input.name) updateData.name = input.name;
    if (input.slug) updateData.slug = input.slug;
    if (input.timezone !== undefined) updateData.timezone = input.timezone;
    if (input.currency !== undefined) updateData.currency = input.currency;
    if (input.fiscalYearStart !== undefined) updateData.fiscalYearStart = input.fiscalYearStart;
    if (input.logo !== undefined) updateData.logo = input.logo;
    if (input.mfaEnforced !== undefined) updateData.mfaEnforced = input.mfaEnforced;
    if (input.allowedEmailDomains !== undefined) updateData.allowedEmailDomains = input.allowedEmailDomains;
    if (input.industry !== undefined) updateData.industry = input.industry;
    if (input.website !== undefined) updateData.website = input.website;
    if (input.legalName !== undefined) updateData.legalName = input.legalName;
    if (input.orgCode !== undefined) updateData.orgCode = input.orgCode;
    if (input.registrationNumber !== undefined) updateData.registrationNumber = input.registrationNumber;
    if (input.taxNumber !== undefined) updateData.taxNumber = input.taxNumber;
    if (input.supportEmail !== undefined) updateData.supportEmail = input.supportEmail;
    if (input.supportPhone !== undefined) updateData.supportPhone = input.supportPhone;
    if (input.favicon !== undefined) updateData.favicon = input.favicon;
    if (input.secondaryColor !== undefined) updateData.secondaryColor = input.secondaryColor;

    const hasSettingsUpdate =
      input.directoryPublic !== undefined ||
      input.primaryColor !== undefined ||
      input.loginBgUrl !== undefined ||
      input.ipAllowlist !== undefined ||
      input.language !== undefined ||
      input.dateFormat !== undefined ||
      input.timeFormat !== undefined ||
      input.numberFormat !== undefined ||
      input.weekStartDay !== undefined;

    if (hasSettingsUpdate) {
      const currentOrg = await this.db.query.organizations.findFirst({
        where: eq(organizations.id, orgId),
      });
      const currentSettings: Record<string, unknown> = currentOrg?.settings ?? {};

      if (input.directoryPublic !== undefined) currentSettings.directoryPublic = input.directoryPublic;
      if (input.primaryColor !== undefined) {
        if (input.primaryColor === null) {
          delete currentSettings.primaryColor;
        } else {
          currentSettings.primaryColor = input.primaryColor;
        }
      }
      if (input.loginBgUrl !== undefined) {
        if (input.loginBgUrl === null) {
          delete currentSettings.loginBgUrl;
        } else {
          currentSettings.loginBgUrl = input.loginBgUrl;
        }
      }
      if (input.ipAllowlist !== undefined) {
        currentSettings.ipAllowlist = input.ipAllowlist;
        if (input.ipAllowlist.length === 0) {
          await this.cache.invalidate(`org:ip-allowlist:${orgId}`);
        } else {
          await this.cache.set(`org:ip-allowlist:${orgId}`, JSON.stringify(input.ipAllowlist), 3600);
        }
      }
      if (input.language !== undefined) currentSettings.language = input.language;
      if (input.dateFormat !== undefined) currentSettings.dateFormat = input.dateFormat;
      if (input.timeFormat !== undefined) currentSettings.timeFormat = input.timeFormat;
      if (input.numberFormat !== undefined) currentSettings.numberFormat = input.numberFormat;
      if (input.weekStartDay !== undefined) currentSettings.weekStartDay = input.weekStartDay;
      updateData.settings = currentSettings;
    }

    if (Object.keys(updateData).length > 0) {
      await this.db.update(organizations).set(updateData).where(eq(organizations.id, orgId));
    }

    this.audit.log({
      action: "settings.updated",
      userId: actorUserId,
      orgId,
      targetId: orgId,
      targetType: "organization",
      metadata: updateData,
    });

    return { success: true };
  }

  async updateSecuritySettings(
    orgId: string,
    actorUserId: string,
    input: SecuritySettingsInput,
  ) {
    const updateData: SecuritySettingsUpdate = {};
    if (input.mfaEnforced !== undefined) updateData.mfaEnforced = input.mfaEnforced;
    if (input.passwordExpiryDays !== undefined) updateData.passwordExpiryDays = input.passwordExpiryDays;
    if (input.allowedEmailDomains !== undefined) updateData.allowedEmailDomains = input.allowedEmailDomains;
    if (input.maxConcurrentSessions !== undefined) updateData.maxConcurrentSessions = input.maxConcurrentSessions;

    if (Object.keys(updateData).length === 0) return { success: true };

    await this.db.update(organizations).set(updateData).where(eq(organizations.id, orgId));

    this.audit.log({
      action: "security_settings.updated",
      userId: actorUserId,
      orgId,
      targetId: orgId,
      targetType: "organization",
      metadata: updateData,
    });

    const members = await this.db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(eq(organizationMembers.orgId, orgId));

    await Promise.allSettled(
      members.map((m) => this.cache.invalidate(CACHE_KEYS.userSession(m.userId))),
    );

    return { success: true };
  }

  async inviteMember(orgId: string, actorUserId: string, input: InviteMemberInput) {
    const existingUser = await this.db.query.users.findFirst({
      where: eq(users.email, input.email),
    });

    if (existingUser) {
      const existingMember = await this.db.query.organizationMembers.findFirst({
        where: and(
          eq(organizationMembers.userId, existingUser.id),
          eq(organizationMembers.orgId, orgId),
        ),
      });
      if (existingMember) throw new ConflictException("User is already a member");
    }

    const existingInvitation = await this.db.query.invitations.findFirst({
      where: and(
        eq(invitations.email, input.email),
        eq(invitations.orgId, orgId),
        gt(invitations.expiresAt, new Date()),
        isNull(invitations.acceptedAt),
      ),
    });
    if (existingInvitation) {
      throw new ConflictException("An invitation has already been sent to this email");
    }

    const org = await this.db.query.organizations.findFirst({
      where: eq(organizations.id, orgId),
    });

    if (org?.allowedEmailDomains && org.allowedEmailDomains.length > 0) {
      const emailDomain = input.email.split("@")[1]?.toLowerCase();
      const allowed = org.allowedEmailDomains.map((d) => d.toLowerCase());
      if (!emailDomain || !allowed.includes(emailDomain)) {
        throw new BadRequestException(
          `Email domain not allowed. Permitted: ${org.allowedEmailDomains.join(", ")}`,
        );
      }
    }

    const invitationId = randomUUID();
    const invitationToken = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    await this.db.insert(invitations).values({
      id: invitationId,
      email: input.email,
      token: invitationToken,
      orgId,
      role: input.role,
      invitedBy: actorUserId,
      expiresAt,
    });

    await this.email.sendInvitationEmail(
      input.email,
      invitationToken,
      org?.name ?? "Unknown Organization",
    );

    this.audit.log({
      action: "org.member_invited",
      userId: actorUserId,
      orgId,
      targetId: invitationId,
      targetType: "invitation",
      metadata: { email: input.email, role: input.role },
    });

    return { success: true, invitationId };
  }

  async updateMemberRole(
    orgId: string,
    actorUserId: string,
    memberUserId: string,
    role: string,
  ) {
    await this.db.transaction(async (tx) => {
      await tx
        .update(organizationMembers)
        .set({ role })
        .where(
          and(
            eq(organizationMembers.userId, memberUserId),
            eq(organizationMembers.orgId, orgId),
          ),
        );
      await tx.update(users).set({ role }).where(eq(users.id, memberUserId));
    });

    this.audit.log({
      action: "org.member_role_changed",
      userId: actorUserId,
      orgId,
      targetId: memberUserId,
      targetType: "user",
      metadata: { newRole: role },
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
