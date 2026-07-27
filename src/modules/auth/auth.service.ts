import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { AccessService } from "../access/access.service";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  organizationMembers,
  organizations,
  roles,
  subscriptions,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { SessionService } from "./session.service";
import { AuthTokensService } from "./auth-tokens.service";
import { addDays } from "date-fns";
import type { RegisterInput } from "./dto/auth.schemas";
import {
  getTrialDays,
  TRIAL_PLAN,
} from "../billing/plan-entitlements.constants";

function slugify(name: string): string {
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

@Injectable()
export class AuthService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly sessionService: SessionService,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly authTokens: AuthTokensService,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  async register(input: RegisterInput): Promise<{ success: true }> {
    const normalizedEmail = input.email.toLowerCase().trim();

    const existing = await this.db.query.users.findFirst({
      where: sql`lower(${users.email}) = ${normalizedEmail}`,
      columns: { id: true },
    });

    if (existing) {
      return { success: true };
    }

    const userId = randomUUID();
    const orgId = randomUUID();

    await this.db.transaction(async (tx) => {
      const seqRows = await tx.execute(
        sql`SELECT nextval(pg_get_serial_sequence('organization_members', 'id')) AS id`,
      );
      const ownerMembershipId = Number(seqRows[0]?.id);
      if (!Number.isInteger(ownerMembershipId)) {
        throw new Error("Failed to allocate owner membership id");
      }

      await tx.insert(organizations).values({
        id: orgId,
        name: input.companyName,
        slug: slugify(input.companyName),
        ownerMembershipId,
      });

      await tx.insert(users).values({
        id: userId,
        email: normalizedEmail,
        name: input.lastName ? `${input.firstName} ${input.lastName}` : input.firstName,
        firstName: input.firstName,
        lastName: input.lastName ?? "",
        role: "OWNER",
        isActive: true,
        hasDashboardAccess: true,
        emailVerified: new Date(),
        lastActiveOrgId: orgId,
      });

      await tx.insert(organizationMembers).values({
        id: ownerMembershipId,
        orgId,
        userId,
        role: "owner",
        isOwner: true,
      });

      const trialDays = getTrialDays();
      await tx.insert(subscriptions).values({
        orgId,
        plan: TRIAL_PLAN,
        status: "TRIAL",
        trialEndsAt: addDays(new Date(), trialDays),
        currentPeriodStart: new Date(),
        currentPeriodEnd: addDays(new Date(), trialDays),
      });

      const adminRole = { name: "Administrator", slug: "ADMIN", isSystem: false };
      await tx.insert(roles).values({ ...adminRole, orgId });
    });

    this.audit.log({
      action: "user.registered",
      userId,
      orgId,
      metadata: { email: normalizedEmail, companyName: input.companyName },
    });

    return { success: true };
  }

  async logout(sessionId: string, userId: string): Promise<void> {
    await this.sessionService.revoke(sessionId, userId);
    this.audit.log({ action: "auth.logout", userId });
  }

  async logoutAll(userId: string, exceptSessionId?: string): Promise<void> {
    await this.sessionService.revokeAll(userId, exceptSessionId);
    this.audit.log({ action: "auth.logout_all", userId });
  }

  async getSessionData(userId: string): Promise<{
    userId: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    name: string | null;
    image: string | null;
    role: string | null;
    isActive: boolean;
    hasDashboardAccess: boolean;
    branchId: number | null;
    totpEnabled: boolean;
    orgId: string | null;
    isOrgOwner: boolean;
    isPlatformAdmin: boolean;
    mfaEnforced: boolean;
    enabledModules: string[];
    orgOnboardingCompletedAt: string | null;
    userOnboardingCompletedAt: string | null;
    permissions: string[];
    plan: string | null;
  }> {
    return this.cache.cached(
      CACHE_KEYS.userSession(userId),
      async () => {
        const user = await this.db.query.users
          .findFirst({
            where: eq(users.id, userId),
            columns: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
              name: true,
              image: true,
              role: true,
              isActive: true,
              hasDashboardAccess: true,
              branchId: true,
              totpEnabled: true,
              onboardingCompletedAt: true,
              lastActiveOrgId: true,
              isPlatformAdmin: true,
            },
          })
          .catch(() => {
            throw new HttpException("Service temporarily unavailable", HttpStatus.SERVICE_UNAVAILABLE);
          });

        if (!user) throw new NotFoundException("User not found");

        const membership = await this.authTokens.resolveActiveMembership(userId, user.lastActiveOrgId ?? null);

        let mfaEnforced = false;
        let enabledModules: string[] = [];
        let orgOnboardingCompletedAt: string | null = null;
        let plan: string | null = null;
        let permissions: string[] = [];

        const resolvedOrgId = membership?.orgId ?? null;
        const isOrgOwner = membership?.isOwner ?? false;

        if (membership) {
          mfaEnforced = membership.mfaEnforced;
          enabledModules = membership.enabledModules ?? [];
          orgOnboardingCompletedAt = membership.orgOnboardingCompletedAt?.toISOString() ?? null;

          const sub = await this.db.query.subscriptions.findFirst({
            where: eq(subscriptions.orgId, membership.orgId),
            columns: { plan: true, status: true },
          });
          if (sub) {
            plan = sub.status === "ACTIVE" || sub.status === "TRIAL" ? sub.plan : "FREE";
          }

          try {
            const permMap = await this.access.resolveUserPermissions(membership.orgId, userId);
            permissions = [...permMap.keys()];
          } catch {
            permissions = [];
          }
        }

        return {
          userId: user.id,
          email: user.email,
          firstName: user.firstName ?? null,
          lastName: user.lastName ?? null,
          name: user.name ?? null,
          image: user.image ?? null,
          role: user.role ?? null,
          isActive: user.isActive,
          hasDashboardAccess: user.hasDashboardAccess,
          branchId: user.branchId ?? null,
          totpEnabled: user.totpEnabled,
          orgId: resolvedOrgId,
          isOrgOwner,
          isPlatformAdmin: user.isPlatformAdmin,
          mfaEnforced,
          enabledModules,
          orgOnboardingCompletedAt,
          userOnboardingCompletedAt: user.onboardingCompletedAt?.toISOString() ?? null,
          permissions,
          plan,
        };
      },
      60,
    );
  }
}
