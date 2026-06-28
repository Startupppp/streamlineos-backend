import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { organizations, users, invitations, orgHolidays } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { EmailService } from "../email/email.service";
import { randomUUID } from "node:crypto";
import { type SetupInput } from "./dto/org.schemas";

@Injectable()
export class OrgSetupService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly email: EmailService,
  ) {}

  async completeSetup(u: CurrentUserContext, input: SetupInput) {
    if (!u.isOrgOwner) {
      throw new ForbiddenException("Forbidden");
    }

    const settings: Record<string, unknown> = {};
    if (input.primaryColor) settings.primaryColor = input.primaryColor;
    if (input.supportEmail) settings.supportEmail = input.supportEmail;
    if (input.businessHours) settings.businessHours = input.businessHours;

    await this.db.transaction(async (tx) => {
      await tx
        .update(organizations)
        .set({
          name: input.companyName,
          industry: input.industry,
          companySize: input.companySize,
          country: input.country,
          ...(input.website ? { website: input.website } : {}),
          ...(input.logo ? { logo: input.logo } : {}),
          ...(input.timezone ? { timezone: input.timezone } : {}),
          ...(input.currency ? { currency: input.currency } : {}),
          ...(input.fiscalYearStart ? { fiscalYearStart: input.fiscalYearStart } : {}),
          ...(input.enabledModules ? { enabledModules: input.enabledModules } : {}),
          ...(Object.keys(settings).length > 0 ? { settings } : {}),
          onboardingCompletedAt: new Date(),
        })
        .where(eq(organizations.id, u.orgId));

      await tx
        .update(users)
        .set({
          firstName: input.firstName,
          lastName: input.lastName,
          name: `${input.firstName} ${input.lastName}`,
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
            orgId: u.orgId,
            name: h.name,
            date: h.date,
            createdBy: u.userId,
          }),
        ),
      );
    }

    if (input.invitees?.length) {
      const org = await this.db.query.organizations.findFirst({ where: eq(organizations.id, u.orgId), columns: { name: true } });
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);
      await Promise.allSettled(
        input.invitees.map(async (inv) => {
          const invitationId = randomUUID();
          const token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
          await this.db.insert(invitations).values({ id: invitationId, email: inv.email, token, orgId: u.orgId, role: inv.role, invitedBy: u.userId, expiresAt }).catch(() => {});
          await this.email.sendInvitationEmail(inv.email, token, org?.name ?? "Your Organization").catch(() => {});
        }),
      );
    }

    await this.cache.invalidate(CACHE_KEYS.userSession(u.userId));

    this.audit.log({ action: "org.setup.completed", userId: u.userId, orgId: u.orgId, targetId: u.orgId, targetType: "organization" });

    return { success: true };
  }
}
