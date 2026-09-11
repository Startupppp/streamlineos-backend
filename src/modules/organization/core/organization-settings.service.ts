import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_TTL } from "../../../common/cache/cache-keys";
import { MfaPolicyService } from "../../access/mfa-policy.service";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import type { TenantTx } from "../../../common/tenant/with-tenant";
import {
  organizationAllowedEmailDomains,
  organizations,
} from "../../../db/schema";
import type {
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
  settings?: Record<string, unknown>;
};

@Injectable()
export class OrganizationSettingsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly mfaPolicy: MfaPolicyService,
  ) {}

  private async invalidateSettingsCache(orgId: string): Promise<void> {
    await Promise.all([
      this.cache.invalidateForOrg(orgId, "org:settings"),
      this.cache.invalidateNamespaceForOrg(orgId, "org:profile"),
      this.mfaPolicy.invalidateOrg(orgId),
    ]);
  }

  async updateSettings(orgId: string, actorUserId: string, input: UpdateOrgSettingsInput) {
    if (input.slug) {
      const existing = await this.db.query.organizations.findFirst({
        columns: { id: true },
        where: and(eq(organizations.slug, input.slug), eq(organizations.id, orgId)),
      });
      if (!existing) {
        const slugTaken = await this.db.query.organizations.findFirst({
          columns: { id: true },
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
    if (input.ipAllowlist !== undefined) {
      const currentOrg = await this.db.query.organizations.findFirst({
        where: eq(organizations.id, orgId),
        columns: { settings: true },
      });
      updateData.settings = {
        ...(currentOrg?.settings ?? {}),
        ipAllowlist: input.ipAllowlist,
      };
    }

    const hasOrgUpdate = Object.keys(updateData).length > 0;
    const hasDomainsUpdate = input.allowedEmailDomains !== undefined;

    if (!hasOrgUpdate && !hasDomainsUpdate) return { success: true };

    const domains = input.allowedEmailDomains;
    await runInTenantTransaction(
      this.db,
      async (tx) => {
        if (hasOrgUpdate)
          await tx.update(organizations).set(updateData).where(eq(organizations.id, orgId));
        if (domains !== undefined) await this.replaceAllowedDomains(tx, orgId, domains);
      },
      { orgId },
    );

    this.audit.log({
      action: "security_settings.updated",
      userId: actorUserId,
      orgId,
      targetId: orgId,
      targetType: "organization",
      metadata: {
        ...(input.mfaEnforced !== undefined ? { mfaEnforced: input.mfaEnforced } : {}),
        ...(input.maxConcurrentSessions !== undefined
          ? { maxConcurrentSessions: input.maxConcurrentSessions }
          : {}),
        ...(input.allowedEmailDomains !== undefined
          ? { allowedEmailDomainCount: input.allowedEmailDomains.length }
          : {}),
        ...(input.ipAllowlist !== undefined
          ? { ipAllowlistCount: input.ipAllowlist.length }
          : {}),
      },
    });

    if (input.ipAllowlist !== undefined) {
      if (input.ipAllowlist.length === 0) {
        await this.cache.invalidateForOrg(orgId, "org:ip-allowlist");
      } else {
        await this.cache.set(
          `${orgId}:org:ip-allowlist`,
          JSON.stringify(input.ipAllowlist),
          3600,
        );
      }
    }
    await this.invalidateSettingsCache(orgId);

    return { success: true };
  }

  private async replaceAllowedDomains(
    tx: TenantTx,
    orgId: string,
    domains: string[],
  ): Promise<void> {
    await tx
      .delete(organizationAllowedEmailDomains)
      .where(eq(organizationAllowedEmailDomains.orgId, orgId));
    if (domains.length > 0) {
      await tx.insert(organizationAllowedEmailDomains).values(
        domains.map((domain) => ({ orgId, domain: domain.toLowerCase() })),
      );
    }
  }

  async getSettings(orgId: string) {
    return this.cache.cachedForOrg(
      orgId,
      "org:settings",
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
        .where(eq(organizationAllowedEmailDomains.orgId, orgId))
        .limit(100),
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
}
