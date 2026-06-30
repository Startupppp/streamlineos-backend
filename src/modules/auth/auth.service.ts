import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { AccessService } from "../access/access.service";
import { and, eq, gt, gte, sql } from "drizzle-orm";
import { randomUUID, createHash, randomBytes, createDecipheriv } from "node:crypto";
import {
  accounts,
  loginHistory,
  magicLinkTokens,
  organizationMembers,
  organizations,
  passwordResetTokens,
  roles,
  subscriptions,
  users,
  userSessions,
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
import { addDays, addHours, addMinutes, subDays } from "date-fns";
import { verifySync } from "otplib";
import type {
  LoginInput,
  RegisterInput,
  ForgotPasswordInput,
  ResetPasswordInput,
  VerifyEmailInput,
  ChangePasswordInput,
  MagicLinkRequestInput,
  GoogleOAuthInput,
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

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

const TOTP_ALGORITHM = "aes-256-gcm";
const TOTP_IV_LENGTH = 12;
const TOTP_TAG_LENGTH = 16;
const TOTP_PREFIX = "enc:v1:";

function decryptTotpSecret(ciphertext: string): string {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw || !ciphertext.startsWith(TOTP_PREFIX)) return ciphertext;
  const key = createHash("sha256").update(raw).digest();
  const data = Buffer.from(ciphertext.slice(TOTP_PREFIX.length), "base64");
  const iv = data.subarray(0, TOTP_IV_LENGTH);
  const tag = data.subarray(TOTP_IV_LENGTH, TOTP_IV_LENGTH + TOTP_TAG_LENGTH);
  const encrypted = data.subarray(TOTP_IV_LENGTH + TOTP_TAG_LENGTH);
  const decipher = createDecipheriv(TOTP_ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

function verifyTotpCode(token: string, encryptedSecret: string): boolean {
  try {
    const result = verifySync({ secret: decryptTotpSecret(encryptedSecret), token, strategy: "totp" });
    return result.valid;
  } catch {
    return false;
  }
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
  ) {}

  private assertPasswordNotEmail(password: string, email: string): void {
    if (password.toLowerCase() === email.toLowerCase()) {
      throw new BadRequestException("Password cannot be the same as your email address");
    }
  }

  async register(input: RegisterInput): Promise<{ userId: string; orgId: string }> {
    const normalizedEmail = input.email.toLowerCase().trim();

    const existing = await this.db.query.users.findFirst({
      where: sql`lower(${users.email}) = ${normalizedEmail}`,
    });
    if (existing) throw new ConflictException("An account with this email already exists");

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

    const verificationToken = generateToken();
    await this.db.delete(verificationTokens).where(eq(verificationTokens.identifier, normalizedEmail));
    await this.db.insert(verificationTokens).values({
      identifier: normalizedEmail,
      token: verificationToken,
      expires: addHours(new Date(), 24),
    });
    void this.email.sendVerificationEmail(normalizedEmail, verificationToken).catch(() => {});

    this.audit.log({
      action: "user.registered",
      userId,
      orgId,
      metadata: { email: normalizedEmail, companyName: input.companyName },
    });

    return { userId, orgId };
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
      await this.logLoginEvent(null, null, "login.failure", false, "INVALID_CREDENTIALS", context);
      throw new UnauthorizedException("Invalid credentials");
    }

    if (!user.isActive) {
      await this.logLoginEvent(user.id, null, "login.failure", false, "ACCOUNT_DEACTIVATED", context);
      throw new UnauthorizedException("Account is deactivated");
    }

    if (!user.emailVerified) {
      await this.logLoginEvent(user.id, null, "login.failure", false, "EMAIL_NOT_VERIFIED", context);
      throw new UnauthorizedException("Please verify your email before signing in");
    }

    if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
      const remainingSeconds = Math.ceil((new Date(user.lockedUntil).getTime() - Date.now()) / 1000);
      await this.logLoginEvent(user.id, null, "login.failure", false, "ACCOUNT_LOCKED", context);
      throw new UnauthorizedException(`ACCOUNT_LOCKED:${remainingSeconds}`);
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
      await this.logLoginEvent(user.id, null, "login.failure", false, "INVALID_CREDENTIALS", context);
      throw new UnauthorizedException("Invalid credentials");
    }

    if (user.loginAttempts && user.loginAttempts > 0) {
      await this.db.update(users).set({ loginAttempts: 0, lockedUntil: null }).where(eq(users.id, user.id));
    }

    const membership = await this.db.query.organizationMembers.findFirst({
      where: eq(organizationMembers.userId, user.id),
      orderBy: (t, { desc }) => [desc(t.joinedAt)],
    });
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
          await this.logLoginEvent(user.id, orgId, "login.failure", false, "SUBSCRIPTION_INACTIVE", context);
          throw new UnauthorizedException("SUBSCRIPTION_INACTIVE");
        }

        const expiryDate = sub.status === "TRIAL" ? sub.trialEndsAt : sub.currentPeriodEnd;
        if (expiryDate) {
          const days = Math.ceil((new Date(expiryDate).getTime() - Date.now()) / 86_400_000);
          if (days < 14) daysUntilExpiry = Math.max(0, days);
        }
      }
    }

    // MFA enforcement: check org policy and per-user setting
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
        await this.logLoginEvent(user.id, orgId, "login.failure", false, "INVALID_MFA_CODE", context);
        throw new UnauthorizedException("Invalid MFA code");
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

    await this.logLoginEvent(user.id, orgId, "login.success", true, null, context);

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

  async forgotPassword(input: ForgotPasswordInput): Promise<void> {
    const normalizedEmail = input.email.toLowerCase().trim();
    const user = await this.db.query.users.findFirst({
      where: sql`lower(${users.email}) = ${normalizedEmail}`,
    });

    if (!user) return;

    const token = generateToken();
    const tokenHash = hashToken(token);

    await this.db
      .delete(passwordResetTokens)
      .where(eq(passwordResetTokens.email, normalizedEmail));

    await this.db.insert(passwordResetTokens).values({
      id: randomUUID(),
      email: normalizedEmail,
      token: tokenHash,
      expiresAt: addHours(new Date(), 1),
    });

    this.audit.log({ action: "auth.password_reset_requested", userId: user.id });

    void this.email.sendPasswordResetEmail(normalizedEmail, token).catch(() => {});
  }

  async resetPassword(input: ResetPasswordInput): Promise<void> {
    const tokenHash = hashToken(input.token);

    const record = await this.db.query.passwordResetTokens.findFirst({
      where: and(
        eq(passwordResetTokens.token, tokenHash),
        gt(passwordResetTokens.expiresAt, new Date()),
      ),
    });
    if (!record) throw new BadRequestException("Invalid or expired reset token");

    const user = await this.db.query.users.findFirst({
      where: sql`lower(${users.email}) = ${record.email.toLowerCase()}`,
    });
    if (!user) throw new NotFoundException("User not found");

    this.assertPasswordNotEmail(input.newPassword, record.email);
    await this.passwordService.checkPasswordHistory(user.id, input.newPassword);

    const newHash = await this.passwordService.hash(input.newPassword);
    await this.db
      .update(users)
      .set({ password: newHash, passwordChangedAt: new Date(), isPasswordChangeRequired: false })
      .where(eq(users.id, user.id));
    await this.passwordService.recordPasswordHistory(user.id, newHash);

    await this.db.delete(passwordResetTokens).where(eq(passwordResetTokens.id, record.id));
    await this.sessionService.revokeAll(user.id);
    await this.cache.invalidate(CACHE_KEYS.userSession(user.id));

    this.audit.log({ action: "auth.password_reset_completed", userId: user.id });
  }

  async verifyEmail(input: VerifyEmailInput): Promise<{ autoLoginToken: string }> {
    const record = await this.db.query.verificationTokens.findFirst({
      where: and(
        eq(verificationTokens.token, input.token),
        gt(verificationTokens.expires, new Date()),
      ),
    });
    if (!record) throw new BadRequestException("Invalid or expired verification token");

    const [updatedUsers] = await Promise.all([
      this.db
        .update(users)
        .set({ emailVerified: new Date() })
        .where(sql`lower(${users.email}) = ${record.identifier.toLowerCase()}`)
        .returning({ id: users.id }),
      this.db
        .delete(verificationTokens)
        .where(eq(verificationTokens.identifier, record.identifier)),
    ]);

    const userId = updatedUsers[0]?.id;
    if (!userId) throw new BadRequestException("User not found");

    const rawToken = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    const expiresAt = addMinutes(new Date(), 5);

    await this.db.insert(magicLinkTokens).values({
      id: randomUUID(),
      userId,
      tokenHash,
      expiresAt,
    });

    return { autoLoginToken: rawToken };
  }

  async resendVerification(email: string): Promise<void> {
    const normalizedEmail = email.toLowerCase().trim();
    const user = await this.db.query.users.findFirst({
      where: sql`lower(${users.email}) = ${normalizedEmail}`,
    });
    if (!user) return;
    if (user.emailVerified) return;

    const token = generateToken();

    await this.db
      .delete(verificationTokens)
      .where(eq(verificationTokens.identifier, normalizedEmail));

    await this.db.insert(verificationTokens).values({
      identifier: normalizedEmail,
      token,
      expires: addHours(new Date(), 24),
    });

    void this.email.sendVerificationEmail(normalizedEmail, token).catch(() => {});
  }

  async getLoginHistory(
    userId: string,
    query: { success?: boolean; from?: Date; to?: Date; page?: number; limit?: number },
  ) {
    const { and: andFn, desc, lte } = await import("drizzle-orm");
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);
    const offset = (page - 1) * limit;

    const conditions = [eq(loginHistory.userId, userId)];
    if (query.success !== undefined) conditions.push(eq(loginHistory.success, query.success));
    if (query.from) conditions.push(gte(loginHistory.createdAt, query.from));
    if (query.to) conditions.push(lte(loginHistory.createdAt, query.to));

    const [data, countResult] = await Promise.all([
      this.db.query.loginHistory.findMany({
        where: andFn(...conditions),
        orderBy: [desc(loginHistory.createdAt)],
        limit,
        offset,
      }),
      this.db.select({ count: sql<number>`count(*)::int` }).from(loginHistory).where(andFn(...conditions)),
    ]);

    return { data, total: countResult[0]?.count ?? 0, page, limit };
  }

  async getAuditAnalytics() {
    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const sevenDaysAgo = subDays(now, 7);

    const [loginsTodayResult, failedLoginsResult, activeSessionsResult, passwordResetsResult] =
      await Promise.all([
        this.db
          .select({ count: sql<number>`count(*)::int` })
          .from(loginHistory)
          .where(and(eq(loginHistory.success, true), gte(loginHistory.createdAt, startOfToday))),
        this.db
          .select({ count: sql<number>`count(*)::int` })
          .from(loginHistory)
          .where(and(eq(loginHistory.success, false), gte(loginHistory.createdAt, sevenDaysAgo))),
        this.db
          .select({ count: sql<number>`count(*)::int` })
          .from(userSessions)
          .where(
            and(eq(userSessions.isRevoked, false), gt(userSessions.expiresAt, now)),
          ),
        this.db
          .select({ count: sql<number>`count(*)::int` })
          .from(loginHistory)
          .where(
            and(
              eq(loginHistory.event, "auth.password_reset_requested"),
              gte(loginHistory.createdAt, sevenDaysAgo),
            ),
          ),
      ]);

    return {
      loginsToday: loginsTodayResult[0]?.count ?? 0,
      failedLoginsLast7Days: failedLoginsResult[0]?.count ?? 0,
      activeSessions: activeSessionsResult[0]?.count ?? 0,
      passwordResetsLast7Days: passwordResetsResult[0]?.count ?? 0,
    };
  }

  private async logLoginEvent(
    userId: string | null,
    orgId: string | null,
    event: string,
    success: boolean,
    failureReason: string | null,
    context: { ipAddress?: string; userAgent?: string },
  ): Promise<void> {
    if (!userId) return;
    await this.db.insert(loginHistory).values({
      id: randomUUID(),
      userId,
      orgId,
      event,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      success,
      failureReason,
    }).catch(() => {});
  }

  async requestMagicLink(input: MagicLinkRequestInput): Promise<void> {
    const user = await this.db.query.users.findFirst({
      where: sql`lower(${users.email}) = ${input.email.toLowerCase()}`,
      columns: { id: true, email: true, emailVerified: true },
    });

    if (!user || !user.emailVerified) return;

    const token = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const expiresAt = addHours(new Date(), 1);

    await this.db.insert(magicLinkTokens).values({
      id: randomUUID(),
      userId: user.id,
      tokenHash,
      expiresAt,
    });

    await this.email.sendMagicLinkEmail(user.email, token);
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
    const [user, membership] = await Promise.all([
      this.db.query.users.findFirst({
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
        },
      }),
      this.db.query.organizationMembers.findFirst({
        where: eq(organizationMembers.userId, userId),
        columns: { orgId: true, isOwner: true },
      }),
    ]);

    if (!user) throw new NotFoundException("User not found");

    let mfaEnforced = false;
    let enabledModules: string[] = [];
    let orgOnboardingCompletedAt: string | null = null;
    let plan: string | null = null;
    let permissions: string[] = [];

    if (membership?.orgId) {
      const orgId = membership.orgId;
      const [org, sub] = await Promise.all([
        this.db.query.organizations.findFirst({
          where: eq(organizations.id, orgId),
          columns: { mfaEnforced: true, enabledModules: true, onboardingCompletedAt: true },
        }),
        this.db.query.subscriptions.findFirst({
          where: eq(subscriptions.orgId, orgId),
          columns: { plan: true, status: true },
        }),
      ]);

      mfaEnforced = org?.mfaEnforced ?? false;
      enabledModules = org?.enabledModules ?? [];
      orgOnboardingCompletedAt = org?.onboardingCompletedAt?.toISOString() ?? null;

      if (sub) {
        plan = sub.status === "ACTIVE" || sub.status === "TRIAL" ? sub.plan : "FREE";
      }

      try {
        const permMap = await this.access.resolveUserPermissions(orgId, userId);
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
      orgId: membership?.orgId ?? null,
      isOrgOwner: membership?.isOwner ?? false,
      mfaEnforced,
      enabledModules,
      orgOnboardingCompletedAt,
      userOnboardingCompletedAt: user.onboardingCompletedAt?.toISOString() ?? null,
      permissions,
      plan,
    };
  }

  async verifyMagicLink(token: string): Promise<{ userId: string; orgId: string; forceChangePassword: boolean }> {
    const tokenHash = createHash("sha256").update(token).digest("hex");

    const row = await this.db.query.magicLinkTokens.findFirst({
      where: and(
        eq(magicLinkTokens.tokenHash, tokenHash),
        gt(magicLinkTokens.expiresAt, new Date()),
      ),
    });

    if (!row || row.usedAt) {
      throw new UnauthorizedException("Invalid or expired magic link");
    }

    await this.db.update(magicLinkTokens).set({ usedAt: new Date() }).where(eq(magicLinkTokens.id, row.id));

    const membership = await this.db.query.organizationMembers.findFirst({
      where: eq(organizationMembers.userId, row.userId),
      columns: { orgId: true },
    });

    const user = await this.db.query.users.findFirst({
      where: eq(users.id, row.userId),
      columns: { isPasswordChangeRequired: true },
    });

    await this.cache.invalidate(CACHE_KEYS.userSession(row.userId));

    return {
      userId: row.userId,
      orgId: membership?.orgId ?? "",
      forceChangePassword: user?.isPasswordChangeRequired ?? false,
    };
  }

  async googleOAuth(input: GoogleOAuthInput): Promise<{ userId: string; isNewUser: boolean }> {
    const normalizedEmail = input.email.toLowerCase().trim();

    const existingAccount = await this.db.query.accounts.findFirst({
      where: and(
        eq(accounts.provider, "google"),
        eq(accounts.providerAccountId, input.googleId),
      ),
      columns: { userId: true },
    });

    if (existingAccount) {
      return { userId: existingAccount.userId, isNewUser: false };
    }

    const existingUser = await this.db.query.users.findFirst({
      where: sql`lower(${users.email}) = ${normalizedEmail}`,
      columns: { id: true, emailVerified: true },
    });

    if (existingUser) {
      await this.db.insert(accounts).values({
        userId: existingUser.id,
        type: "oauth",
        provider: "google",
        providerAccountId: input.googleId,
      }).onConflictDoNothing();

      if (!existingUser.emailVerified) {
        await this.db.update(users).set({ emailVerified: new Date() }).where(eq(users.id, existingUser.id));
      }

      return { userId: existingUser.id, isNewUser: false };
    }

    const userId = randomUUID();
    const rawName = (input.name ?? normalizedEmail.split("@")[0]).trim();
    const spaceIdx = rawName.indexOf(" ");
    const firstName = spaceIdx === -1 ? rawName : rawName.slice(0, spaceIdx);
    const lastName = spaceIdx === -1 ? "" : rawName.slice(spaceIdx + 1).trim();

    await this.db.transaction(async (tx) => {
      await tx.insert(users).values({
        id: userId,
        email: normalizedEmail,
        name: rawName,
        firstName,
        lastName,
        image: input.image || null,
        role: "OWNER",
        isActive: true,
        hasDashboardAccess: true,
        isPasswordChangeRequired: false,
        emailVerified: new Date(),
      });

      await tx.insert(accounts).values({
        userId,
        type: "oauth",
        provider: "google",
        providerAccountId: input.googleId,
      });
    });

    this.audit.log({ action: "user.registered", userId, metadata: { email: normalizedEmail, provider: "google" } });

    return { userId, isNewUser: true };
  }

}
