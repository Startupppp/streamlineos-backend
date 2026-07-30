import { BadRequestException, ConflictException, Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import {
  orgCustomDomains,
  orgHolidays,
  organizationAllowedEmailDomains,
  organizationMembers,
  organizations,
} from "../../db/schema";
import type {
  AddCustomDomainInput,
  CreateHolidayInput,
  SecuritySettingsInput,
  UpdateOrgSettingsInput,
} from "./dto/organization.schemas";

type OrgSettingsUpdate = {
  name?: string;
  slug?: string;
  logo?: string | null;
  timezone?: string;
  currency?: string;
  fiscalYearStart?: number;
  mfaEnforced?: boolean;
  settings?: Record<string, unknown>;
  industry?: string | null;
  website?: string | null;
  legalName?: string | null;
  orgCode?: string | null;
  registrationNumber?: string | null;
  taxNumber?: string | null;
  supportEmail?: string | null;
  supportPhone?: string | null;
  favicon?: string | null;
  secondaryColor?: string | null;
  businessHours?: Record<string, { open: string; close: string; enabled: boolean }> | null;
  companySize?: string | null;
  country?: string | null;
};

type SecuritySettingsUpdate = {
  mfaEnforced?: boolean;
  maxConcurrentSessions?: number | null;
};

@Injectable()
export class OrganizationSettingsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
  ) {}

  private async invalidateSettingsCache(orgId: string): Promise<void> {
    await Promise.all([
      this.cache.invalidate(CACHE_KEYS.orgSettings(orgId)),
      this.cache.invalidatePattern(CACHE_KEYS.orgProfilePattern(orgId)),
    ]);
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
    if (input.industry !== undefined) updateData.industry = input.industry;
    if (input.website !== undefined) updateData.website = input.website;
    if (input.legalName !== undefined) updateData.legalName = input.legalName;
    if (input.orgCode !== undefined) updateData.orgCode = input.orgCode;
    if (input.registrationNumber !== undefined)
      updateData.registrationNumber = input.registrationNumber;
    if (input.taxNumber !== undefined) updateData.taxNumber = input.taxNumber;
    if (input.supportEmail !== undefined) updateData.supportEmail = input.supportEmail;
    if (input.supportPhone !== undefined) updateData.supportPhone = input.supportPhone;
    if (input.favicon !== undefined) updateData.favicon = input.favicon;
    if (input.secondaryColor !== undefined) updateData.secondaryColor = input.secondaryColor;
    if (input.businessHours !== undefined) updateData.businessHours = input.businessHours;
    if (input.companySize !== undefined) updateData.companySize = input.companySize;
    if (input.country !== undefined) updateData.country = input.country;

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

      if (input.directoryPublic !== undefined)
        currentSettings.directoryPublic = input.directoryPublic;
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
          await this.cache.set(
            `org:ip-allowlist:${orgId}`,
            JSON.stringify(input.ipAllowlist),
            3600,
          );
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

    if (input.allowedEmailDomains !== undefined) {
      await this.replaceAllowedDomains(orgId, input.allowedEmailDomains);
    }

    await this.invalidateSettingsCache(orgId);

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
    if (input.maxConcurrentSessions !== undefined)
      updateData.maxConcurrentSessions = input.maxConcurrentSessions;

    const hasOrgUpdate = Object.keys(updateData).length > 0;
    const hasDomainsUpdate = input.allowedEmailDomains !== undefined;

    if (!hasOrgUpdate && !hasDomainsUpdate) return { success: true };

    const ops: Promise<unknown>[] = [];

    if (hasOrgUpdate) {
      ops.push(this.db.update(organizations).set(updateData).where(eq(organizations.id, orgId)));
    }
    if (hasDomainsUpdate) {
      ops.push(this.replaceAllowedDomains(orgId, input.allowedEmailDomains!));
    }
    await Promise.all(ops);

    this.audit.log({
      action: "security_settings.updated",
      userId: actorUserId,
      orgId,
      targetId: orgId,
      targetType: "organization",
      metadata: { ...updateData, ...(hasDomainsUpdate ? { allowedEmailDomains: input.allowedEmailDomains } : {}) },
    });

    await this.cache.invalidate(CACHE_KEYS.orgSettings(orgId));

    const members = await this.db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(eq(organizationMembers.orgId, orgId));

    await Promise.allSettled(
      members.map((m) => this.cache.invalidate(CACHE_KEYS.userSession(m.userId))),
    );

    return { success: true };
  }

  private async replaceAllowedDomains(orgId: string, domains: string[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .delete(organizationAllowedEmailDomains)
        .where(eq(organizationAllowedEmailDomains.orgId, orgId));
      if (domains.length > 0) {
        await tx.insert(organizationAllowedEmailDomains).values(
          domains.map((domain) => ({ orgId, domain: domain.toLowerCase() })),
        );
      }
    });
  }

  async getSettings(orgId: string) {
    return this.cache.cached(
      CACHE_KEYS.orgSettings(orgId),
      () => this.fetchSettings(orgId),
      CACHE_TTL.MEDIUM,
    );
  }

  private async fetchSettings(orgId: string) {
    const [data, domainRows] = await Promise.all([
      this.db.query.organizations.findFirst({ where: eq(organizations.id, orgId) }),
      this.db
        .select({ domain: organizationAllowedEmailDomains.domain })
        .from(organizationAllowedEmailDomains)
        .where(eq(organizationAllowedEmailDomains.orgId, orgId)),
    ]);
    if (!data) return null;

    const settings: Record<string, unknown> = data.settings ?? {};
    return {
      ...data,
      allowedEmailDomains: domainRows.map((r) => r.domain),
      primaryColor: typeof settings.primaryColor === "string" ? settings.primaryColor : null,
      loginBgUrl: typeof settings.loginBgUrl === "string" ? settings.loginBgUrl : null,
      ipAllowlist: Array.isArray(settings.ipAllowlist) ? settings.ipAllowlist : [],
      directoryPublic:
        typeof settings.directoryPublic === "boolean" ? settings.directoryPublic : false,
    };
  }

  listHolidays(orgId: string) {
    return this.db
      .select()
      .from(orgHolidays)
      .where(eq(orgHolidays.orgId, orgId))
      .orderBy(orgHolidays.date);
  }

  async createHoliday(orgId: string, userId: string, input: CreateHolidayInput) {
    const id = randomUUID();
    const [holiday] = await this.db
      .insert(orgHolidays)
      .values({
        id,
        orgId,
        name: input.name,
        date: input.date,
        recurring: input.recurring ?? false,
        createdBy: userId,
      })
      .returning();
    this.audit.log({
      action: "org.holiday.created",
      userId,
      orgId,
      targetId: id,
      targetType: "org_holiday",
      metadata: input,
    });
    return holiday;
  }

  async deleteHoliday(orgId: string, userId: string, holidayId: string) {
    await this.db
      .delete(orgHolidays)
      .where(and(eq(orgHolidays.id, holidayId), eq(orgHolidays.orgId, orgId)));
    this.audit.log({
      action: "org.holiday.deleted",
      userId,
      orgId,
      targetId: holidayId,
      targetType: "org_holiday",
    });
    return { success: true };
  }

  listCustomDomains(orgId: string) {
    return this.db
      .select()
      .from(orgCustomDomains)
      .where(eq(orgCustomDomains.orgId, orgId))
      .orderBy(orgCustomDomains.createdAt);
  }

  async addCustomDomain(orgId: string, userId: string, input: AddCustomDomainInput) {
    const existing = await this.db.query.orgCustomDomains.findFirst({
      where: eq(orgCustomDomains.domain, input.domain),
    });
    if (existing) throw new ConflictException("Domain already registered");
    const id = randomUUID();
    const verificationToken = `streamline-verify=${randomUUID().replace(/-/g, "")}`;
    const [domain] = await this.db
      .insert(orgCustomDomains)
      .values({ id, orgId, domain: input.domain, verificationToken, createdBy: userId })
      .returning();
    this.audit.log({
      action: "org.domain.added",
      userId,
      orgId,
      targetId: id,
      targetType: "org_custom_domain",
      metadata: { domain: input.domain },
    });
    return domain;
  }

  async verifyCustomDomain(orgId: string, userId: string, domainId: string) {
    const record = await this.db.query.orgCustomDomains.findFirst({
      where: and(eq(orgCustomDomains.id, domainId), eq(orgCustomDomains.orgId, orgId)),
    });
    if (!record) throw new BadRequestException("Domain not found");
    this.audit.log({
      action: "org.domain.verified",
      userId,
      orgId,
      targetId: domainId,
      targetType: "org_custom_domain",
    });
    await this.db
      .update(orgCustomDomains)
      .set({ verifiedAt: new Date() })
      .where(eq(orgCustomDomains.id, domainId));
    return { success: true, verified: true };
  }

  async removeCustomDomain(orgId: string, userId: string, domainId: string) {
    await this.db
      .delete(orgCustomDomains)
      .where(and(eq(orgCustomDomains.id, domainId), eq(orgCustomDomains.orgId, orgId)));
    this.audit.log({
      action: "org.domain.removed",
      userId,
      orgId,
      targetId: domainId,
      targetType: "org_custom_domain",
    });
    return { success: true };
  }
}
