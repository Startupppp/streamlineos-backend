import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { AccessService } from "../access/access.service";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { eq, sql } from "drizzle-orm";
import { randomUUID, randomBytes } from "node:crypto";
import {
  organizationMembers,
  organizations,
  roles,
  subscriptions,
  users,
  verificationTokens,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { EmailService } from "../email/email.service";
import { SessionService } from "./session.service";
import { AuthTokensService } from "./auth-tokens.service";
import { hashToken } from "../../common/security/token.util";
import { addDays, addHours } from "date-fns";
import type { RegisterInput } from "./dto/auth.schemas";

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

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly sessionService: SessionService,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    private readonly access: AccessService,
    private readonly authTokens: AuthTokensService,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  async register(input: RegisterInput): Promise<{ success: true }> {
    const normalizedEmail = input.email.toLowerCase().trim();

    const existing = await this.db.query.users.findFirst({
      where: sql`lower(${users.email}) = ${normalizedEmail}`,
      columns: { id: true, emailVerified: true },
    });

    if (existing) {
      if (!existing.emailVerified) {
        const rawToken = generateToken();
        await this.db.delete(verificationTokens).where(eq(verificationTokens.identifier, normalizedEmail));
        await this.db.insert(verificationTokens).values({
          identifier: normalizedEmail,
          token: hashToken(rawToken),
          expires: addHours(new Date(), 24),
        });
        try {
          await this.email.sendVerificationEmail(normalizedEmail, rawToken);
        } catch {
          throw new ServiceUnavailableException(
            "Account exists but we could not send the verification email. Try resend on the signup page.",
          );
        }
      }
      return { success: true };
    }

    const userId = randomUUID();
    const orgId = randomUUID();

    await this.db.transaction(async (tx) => {
      await tx.insert(organizations).values({
        id: orgId,
        name: input.companyName,
        slug: slugify(input.companyName),
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
        emailVerified: null,
        lastActiveOrgId: orgId,
      });

      await tx.insert(organizationMembers).values({
        orgId,
        userId,
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

      const adminRole = { name: "Administrator", slug: "ADMIN", isSystem: false };
      await tx.insert(roles).values({ ...adminRole, orgId });
    });

    const rawToken = generateToken();
    await this.db.delete(verificationTokens).where(eq(verificationTokens.identifier, normalizedEmail));
    await this.db.insert(verificationTokens).values({
      identifier: normalizedEmail,
      token: hashToken(rawToken),
      expires: addHours(new Date(), 24),
    });
    try {
      await this.email.sendVerificationEmail(normalizedEmail, rawToken);
    } catch {
      throw new ServiceUnavailableException(
        "Account created but we could not send the verification email. Try resend on the signup page.",
      );
    }

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
