import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import {
  organizations,
  organizationMembers,
  subscriptions,
  roles,
  users,
  invitations,
  orgHolidays,
  magicLinkTokens,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { EmailService } from "../email/email.service";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { addDays, addHours } from "date-fns";
import { type SetupInput } from "./dto/org.schemas";

@Injectable()
export class OrgSetupService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly email: EmailService,
  ) {}

  private slugify(name: string): string {
    return (
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .substring(0, 50) +
      "-" +
      Date.now().toString(36)
    );
  }

  private async resolveOrCreateOrg(
    u: CurrentUserContext,
    input: SetupInput,
  ): Promise<string> {
    console.log("[OrgSetup] resolveOrCreateOrg", { userId: u.userId, orgId: u.orgId });
    if (u.orgId) {
      const existingOrg = await this.db.query.organizations.findFirst({
        where: eq(organizations.id, u.orgId),
        columns: { id: true },
      });
      if (existingOrg) {
        console.log("[OrgSetup] existing org found via JWT orgId:", u.orgId);
        return u.orgId;
      }
    }

    const existingMember = await this.db.query.organizationMembers.findFirst({
      where: eq(organizationMembers.userId, u.userId),
      columns: { orgId: true },
    });
    if (existingMember) {
      console.log("[OrgSetup] existing member found, orgId:", existingMember.orgId);
      return existingMember.orgId;
    }

    const orgId = randomUUID();
    const orgName = input.companyName?.trim() || "My Organization";
    console.log("[OrgSetup] creating new org, orgId:", orgId, "orgName:", orgName);

    await this.db.transaction(async (tx) => {
      await tx.insert(organizations).values({
        id: orgId,
        name: orgName,
        slug: this.slugify(orgName),
      });
      await tx.insert(organizationMembers).values({
        orgId,
        userId: u.userId,
        role: "owner",
        isOwner: true,
      });
      await tx.insert(subscriptions).values({
        orgId,
        plan: "STARTER",
        status: "TRIAL",
        trialEndsAt: addDays(new Date(), 14),
        currentPeriodStart: new Date(),
        currentPeriodEnd: addDays(new Date(), 14),
      });
      await tx.insert(roles).values({
        name: "Administrator",
        slug: "ADMIN",
        isSystem: false,
        orgId,
        permissions: [],
      });
    });

    this.audit.log({
      action: "org.created",
      userId: u.userId,
      orgId,
      targetId: orgId,
      targetType: "organization",
    });
    return orgId;
  }

  async completeSetup(u: CurrentUserContext, input: SetupInput) {
    console.log("[OrgSetup] completeSetup start", { userId: u.userId, orgId: u.orgId, isOrgOwner: u.isOrgOwner });
    const orgId = await this.resolveOrCreateOrg(u, input);
    console.log("[OrgSetup] resolved orgId:", orgId);
    if (u.orgId && !u.isOrgOwner) {
      console.log("[OrgSetup] early return (not owner, already has org)");
      return { success: true };
    }

    const settings: Record<string, unknown> = {};
    if (input.primaryColor) settings.primaryColor = input.primaryColor;
    if (input.supportEmail) settings.supportEmail = input.supportEmail;
    if (input.businessHours) settings.businessHours = input.businessHours;

    await this.db.transaction(async (tx) => {
      await tx
        .update(organizations)
        .set({
          industry: input.industry,
          companySize: input.companySize,
          ...(input.logo ? { logo: input.logo } : {}),
          ...(input.country ? { country: input.country } : {}),
          ...(input.website ? { website: input.website } : {}),
          ...(input.timezone ? { timezone: input.timezone } : {}),
          ...(input.currency ? { currency: input.currency } : {}),
          ...(input.companyName ? { name: input.companyName } : {}),
          ...(Object.keys(settings).length > 0 ? { settings } : {}),
          ...(input.enabledModules
            ? { enabledModules: input.enabledModules }
            : {}),
          ...(input.fiscalYearStart
            ? { fiscalYearStart: input.fiscalYearStart }
            : {}),
          onboardingCompletedAt: new Date(),
        })
        .where(eq(organizations.id, orgId));

      await tx
        .update(users)
        .set({
          firstName: input.firstName,
          lastName: input.lastName,
          name:
            [input.firstName, input.lastName]
              .filter(Boolean)
              .join(" ")
              .trim() || undefined,
          designation: input.jobTitle,
          ...(input.phone ? { phone: input.phone } : {}),
        })
        .where(eq(users.id, u.userId));
    });

    if (input.holidays?.length) {
      await Promise.allSettled(
        input.holidays.map((h) =>
          this.db.insert(orgHolidays).values({
            id: randomUUID(),
            orgId,
            name: h.name,
            date: h.date,
            createdBy: u.userId,
          }),
        ),
      );
    }

    if (input.invitees?.length) {
      const org = await this.db.query.organizations.findFirst({
        where: eq(organizations.id, orgId),
        columns: { name: true },
      });
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);
      await Promise.allSettled(
        input.invitees.map(async (inv) => {
          const invitationId = randomUUID();
          const token =
            randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
          await this.db
            .insert(invitations)
            .values({
              id: invitationId,
              email: inv.email,
              token,
              orgId,
              role: inv.role,
              invitedBy: u.userId,
              expiresAt,
            })
            .catch(() => {});
          await this.email
            .sendInvitationEmail(
              inv.email,
              token,
              org?.name ?? "Your Organization",
            )
            .catch(() => {});
        }),
      );
    }

    await this.cache.invalidate(CACHE_KEYS.userSession(u.userId));

    this.audit.log({
      action: "org.setup.completed",
      userId: u.userId,
      orgId,
      targetId: orgId,
      targetType: "organization",
    });

    console.log("[OrgSetup] creating autoLoginToken for userId:", u.userId);
    const autoLoginToken = randomBytes(32).toString("hex");
    await this.db.insert(magicLinkTokens).values({
      id: randomUUID(),
      userId: u.userId,
      tokenHash: createHash("sha256").update(autoLoginToken).digest("hex"),
      expiresAt: addHours(new Date(), 1),
    });
    console.log("[OrgSetup] returning success with orgId:", orgId, "hasToken: true");

    return { success: true, orgId, autoLoginToken };
  }
}
