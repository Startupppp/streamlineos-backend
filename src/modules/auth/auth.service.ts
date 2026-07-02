import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { AccessService } from "../access/access.service";
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
import { PasswordService } from "./password.service";
import { DeviceService } from "./device.service";
import { SessionService } from "./session.service";
import { AuthTokensService } from "./auth-tokens.service";
import { decryptTotpSecret, verifyTotpCode } from "./totp.util";
import { hashToken } from "../../common/security/token.util";
import { addDays, addHours } from "date-fns";
import type {
  LoginInput,
  RegisterInput,
  ChangePasswordInput,
} from "./dto/auth.schemas";

const LOCK_AFTER_ATTEMPTS = 5;
const LOCK_DURATION_MINUTES = 15;

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
    private readonly passwordService: PasswordService,
    private readonly sessionService: SessionService,
    private readonly deviceService: DeviceService,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    private readonly access: AccessService,
    private readonly authTokens: AuthTokensService,
  ) {}

  private assertPasswordNotEmail(password: string, email: string): void {
    if (password.toLowerCase() === email.toLowerCase()) {
      throw new BadRequestException("Password cannot be the same as your email address");
    }
  }

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
        void this.email.sendVerificationEmail(normalizedEmail, rawToken).catch(() => {});
      }
      return { success: true };
    }

    this.assertPasswordNotEmail(input.password, normalizedEmail);
    const passwordHash = await this.passwordService.hash(input.password);
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
        password: passwordHash,
        role: "OWNER",
        isActive: true,
        hasDashboardAccess: true,
        isPasswordChangeRequired: false,
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
      await tx.insert(roles).values({ ...adminRole, orgId, permissions: [] });
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

  async login(
    input: LoginInput,
    context: { ipAddress?: string; userAgent?: string; fingerprint?: string },
  ): Promise<{
    userId: string;
    orgId: string;
    sessionId?: string;
    deviceId?: string;
    isNewDevice?: boolean;
    forceChangePassword?: boolean;
    daysUntilExpiry?: number;
    requiresMfa?: boolean;
  }> {
    const normalizedEmail = input.email.toLowerCase().trim();

    const user = await this.db.query.users.findFirst({
      where: sql`lower(${users.email}) = ${normalizedEmail}`,
    });

    if (!user || !user.password) {
      await this.authTokens.logLoginEvent(null, null, "login.failure", false, "INVALID_CREDENTIALS", context);
      throw new UnauthorizedException({ code: "AUTH_INVALID_CREDENTIALS", message: "Invalid credentials" });
    }

    if (!user.isActive) {
      await this.authTokens.logLoginEvent(user.id, null, "login.failure", false, "ACCOUNT_DEACTIVATED", context);
      throw new UnauthorizedException("Account is deactivated");
    }

    if (!user.emailVerified) {
      await this.authTokens.logLoginEvent(user.id, null, "login.failure", false, "EMAIL_NOT_VERIFIED", context);
      throw new UnauthorizedException({ code: "AUTH_EMAIL_NOT_VERIFIED", message: "Please verify your email before signing in" });
    }

    if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
      const remainingSeconds = Math.ceil((new Date(user.lockedUntil).getTime() - Date.now()) / 1000);
      await this.authTokens.logLoginEvent(user.id, null, "login.failure", false, "ACCOUNT_LOCKED", context);
      throw new UnauthorizedException({ code: "AUTH_ACCOUNT_LOCKED", message: "Account locked. Try again later.", details: { retryAfterSeconds: remainingSeconds } });
    }

    const isValid = await this.passwordService.verify(input.password, user.password);
    if (!isValid) {
      const attempts = (user.loginAttempts ?? 0) + 1;
      const update: Record<string, unknown> = { loginAttempts: attempts };
      if (attempts >= LOCK_AFTER_ATTEMPTS) {
        update.lockedUntil = addHours(new Date(), LOCK_DURATION_MINUTES / 60);
        void this.email.sendAccountLockedEmail?.(user.email, user.name ?? user.email).catch(() => {});
      }
      await this.db.update(users).set(update).where(eq(users.id, user.id));
      await this.authTokens.logLoginEvent(user.id, null, "login.failure", false, "INVALID_CREDENTIALS", context);
      throw new UnauthorizedException({ code: "AUTH_INVALID_CREDENTIALS", message: "Invalid credentials" });
    }

    if (user.loginAttempts && user.loginAttempts > 0) {
      await this.db.update(users).set({ loginAttempts: 0, lockedUntil: null }).where(eq(users.id, user.id));
    }

    const membership = await this.authTokens.resolveActiveMembership(user.id, user.lastActiveOrgId ?? null);
    const orgId = membership?.orgId ?? "";

    let daysUntilExpiry: number | undefined;
    if (orgId) {
      const sub = await this.db.query.subscriptions.findFirst({
        where: eq(subscriptions.orgId, orgId),
        columns: { status: true, trialEndsAt: true, currentPeriodEnd: true },
      });
      if (sub) {
        const isExpired =
          sub.status === "EXPIRED" ||
          sub.status === "CANCELLED" ||
          (sub.status === "TRIAL" && sub.trialEndsAt != null && new Date(sub.trialEndsAt) < new Date());

        if (isExpired) {
          await this.authTokens.logLoginEvent(user.id, orgId, "login.failure", false, "SUBSCRIPTION_INACTIVE", context);
          throw new UnauthorizedException({ code: "AUTH_SUBSCRIPTION_INACTIVE", message: "Your subscription is inactive. Please renew to continue." });
        }

        const expiryDate = sub.status === "TRIAL" ? sub.trialEndsAt : sub.currentPeriodEnd;
        if (expiryDate) {
          const days = Math.ceil((new Date(expiryDate).getTime() - Date.now()) / 86_400_000);
          if (days < 14) daysUntilExpiry = Math.max(0, days);
        }
      }
    }

    const mfaRequired = !!user.totpEnabled || !!(await (async () => {
      if (!orgId) return false;
      const [org] = await this.db
        .select({ mfaEnforced: organizations.mfaEnforced })
        .from(organizations)
        .where(eq(organizations.id, orgId));
      return org?.mfaEnforced ?? false;
    })());

    if (mfaRequired) {
      if (!input.totpCode) {
        return { userId: user.id, orgId, requiresMfa: true };
      }
      if (!user.totpSecret || !verifyTotpCode(input.totpCode, user.totpSecret)) {
        await this.authTokens.logLoginEvent(user.id, orgId, "login.failure", false, "INVALID_MFA_CODE", context);
        throw new UnauthorizedException({ code: "AUTH_INVALID_MFA_CODE", message: "Invalid MFA code" });
      }
    }

    const device = await this.deviceService.findOrCreate({
      userId: user.id,
      fingerprint: context.fingerprint ?? context.userAgent ?? "unknown",
      browser: context.userAgent?.split(" ")?.[0],
    });

    const expiresAt = input.rememberMe ? addDays(new Date(), 30) : addDays(new Date(), 1);
    const sessionId = await this.sessionService.create({
      userId: user.id,
      userAgent: context.userAgent,
      ipAddress: context.ipAddress,
      deviceId: device.id,
      expiresAt,
    });

    if (orgId) {
      const [org] = await this.db
        .select({ maxConcurrentSessions: organizations.maxConcurrentSessions })
        .from(organizations)
        .where(eq(organizations.id, orgId));
      if (org?.maxConcurrentSessions) {
        await this.sessionService.enforceMaxSessions(user.id, org.maxConcurrentSessions, sessionId);
      }
    }

    await this.authTokens.logLoginEvent(user.id, orgId, "login.success", true, null, context);

    this.audit.log({
      action: "auth.login",
      userId: user.id,
      orgId,
      ipAddress: context.ipAddress,
      metadata: { userAgent: context.userAgent },
    });

    await this.cache.invalidate(CACHE_KEYS.userSession(user.id));

    return {
      userId: user.id,
      orgId,
      sessionId,
      deviceId: device.id,
      isNewDevice: !device.trusted,
      forceChangePassword: user.isPasswordChangeRequired ?? false,
      ...(daysUntilExpiry !== undefined && { daysUntilExpiry }),
    };
  }

  async logout(sessionId: string, userId: string): Promise<void> {
    await this.sessionService.revoke(sessionId, userId);
    this.audit.log({ action: "auth.logout", userId });
  }

  async logoutAll(userId: string, exceptSessionId?: string): Promise<void> {
    await this.sessionService.revokeAll(userId, exceptSessionId);
    this.audit.log({ action: "auth.logout_all", userId });
  }

  async changePassword(userId: string, input: ChangePasswordInput): Promise<void> {
    const user = await this.db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user || !user.password) throw new NotFoundException("User not found");

    const isValid = await this.passwordService.verify(input.currentPassword, user.password);
    if (!isValid) throw new BadRequestException("Current password is incorrect");

    this.assertPasswordNotEmail(input.newPassword, user.email);
    await this.passwordService.checkPasswordHistory(userId, input.newPassword);

    const newHash = await this.passwordService.hash(input.newPassword);
    await this.db
      .update(users)
      .set({ password: newHash, passwordChangedAt: new Date(), isPasswordChangeRequired: false })
      .where(eq(users.id, userId));
    await this.passwordService.recordPasswordHistory(userId, newHash);

    await this.sessionService.revokeAll(userId);
    await this.cache.invalidate(CACHE_KEYS.userSession(userId));

    this.audit.log({ action: "auth.password_changed", userId });

    void this.email
      .sendPasswordChangeConfirmationEmail?.(user.email, user.name ?? user.email)
      .catch(() => {});
  }

  async forceChangePassword(userId: string, password: string, sessionId: string): Promise<{ success: true }> {
    const user = await this.db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user) throw new NotFoundException("User not found");

    this.assertPasswordNotEmail(password, user.email);
    await this.passwordService.checkPasswordHistory(userId, password);

    const newHash = await this.passwordService.hash(password);
    await this.db
      .update(users)
      .set({ password: newHash, passwordChangedAt: new Date(), isPasswordChangeRequired: false })
      .where(eq(users.id, userId));
    await this.passwordService.recordPasswordHistory(userId, newHash);

    await this.sessionService.revokeAll(userId, sessionId);
    await this.cache.invalidate(CACHE_KEYS.userSession(userId));

    this.audit.log({ action: "auth.password_changed", userId, metadata: { forced: true } });

    return { success: true };
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
    isPasswordChangeRequired: boolean;
    branchId: number | null;
    totpEnabled: boolean;
    orgId: string | null;
    isOrgOwner: boolean;
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
              isPasswordChangeRequired: true,
              branchId: true,
              totpEnabled: true,
              onboardingCompletedAt: true,
              lastActiveOrgId: true,
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
          isPasswordChangeRequired: user.isPasswordChangeRequired,
          branchId: user.branchId ?? null,
          totpEnabled: user.totpEnabled,
          orgId: resolvedOrgId,
          isOrgOwner,
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
