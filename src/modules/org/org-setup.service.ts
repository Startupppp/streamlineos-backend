import { Inject, Injectable } from "@nestjs/common";
import { desc, eq, inArray } from "drizzle-orm";
import {
  organizations,
  organizationMembers,
  subscriptions,
  roles,
  users,
  magicLinkTokens,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { addDays, addMinutes } from "date-fns";
import { type SetupInput } from "./dto/org.schemas";

@Injectable()
export class OrgSetupService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
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
    if (u.orgId) {
      const existingOrg = await this.db.query.organizations.findFirst({
        where: eq(organizations.id, u.orgId),
        columns: { id: true },
      });
      if (existingOrg) {
        return u.orgId;
      }
    }

    const memberships = await this.db
      .select({
        id: organizationMembers.id,
        orgId: organizationMembers.orgId,
        existingOrgId: organizations.id,
      })
      .from(organizationMembers)
      .leftJoin(organizations, eq(organizations.id, organizationMembers.orgId))
      .where(eq(organizationMembers.userId, u.userId))
      .orderBy(desc(organizationMembers.joinedAt));

    const valid = memberships.find((m) => m.existingOrgId !== null);
    if (valid) {
      return valid.orgId;
    }

    const orphanIds = memberships.map((m) => m.id);
    if (orphanIds.length > 0) {
      await this.db
        .delete(organizationMembers)
        .where(inArray(organizationMembers.id, orphanIds));
    }

    const orgId = randomUUID();
    const orgName = input.companyName?.trim() || "My Organization";

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
    const orgId = await this.resolveOrCreateOrg(u, input);
    if (u.orgId && !u.isOrgOwner) {
      return { success: true, orgId };
    }

    await this.db.transaction(async (tx) => {
      await tx
        .update(organizations)
        .set({
          industry: input.industry,
          companySize: input.companySize,
          ...(input.country ? { country: input.country } : {}),
          ...(input.timezone ? { timezone: input.timezone } : {}),
          ...(input.companyName ? { name: input.companyName } : {}),
          ...(input.enabledModules
            ? { enabledModules: input.enabledModules }
            : {}),
          onboardingCompletedAt: new Date(),
        })
        .where(eq(organizations.id, orgId));

      await tx
        .update(users)
        .set({ lastActiveOrgId: orgId })
        .where(eq(users.id, u.userId));
    });

    await this.cache.invalidate(CACHE_KEYS.userSession(u.userId));

    this.audit.log({
      action: "org.setup.completed",
      userId: u.userId,
      orgId,
      targetId: orgId,
      targetType: "organization",
    });

    const autoLoginToken = randomBytes(32).toString("hex");
    await this.db.insert(magicLinkTokens).values({
      id: randomUUID(),
      userId: u.userId,
      tokenHash: createHash("sha256").update(autoLoginToken).digest("hex"),
      expiresAt: addMinutes(new Date(), 10),
    });

    return { success: true, orgId, autoLoginToken };
  }
}
