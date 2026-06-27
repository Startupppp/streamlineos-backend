import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { and, eq, gt, sql } from "drizzle-orm";
import { randomUUID, createHash, randomBytes } from "node:crypto";
import {
  loginHistory,
  organizationMembers,
  organizations,
  passwordResetTokens,
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
import { addDays, addHours } from "date-fns";
import type {
  LoginInput,
  RegisterInput,
  ForgotPasswordInput,
  ResetPasswordInput,
  VerifyEmailInput,
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

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
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
  ) {}

  async register(input: RegisterInput): Promise<{ userId: string; orgId: string }> {
    const normalizedEmail = input.email.toLowerCase().trim();

    const existing = await this.db.query.users.findFirst({
      where: sql`lower(${users.email}) = ${normalizedEmail}`,
    });
    if (existing) throw new ConflictException("An account with this email already exists");

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
        name: `${input.firstName} ${input.lastName}`,
        firstName: input.firstName,
        lastName: input.lastName,
        password: passwordHash,
        role: "OWNER",
        isActive: true,
        hasDashboardAccess: true,
        emailVerified: new Date(),
        isPasswordChangeRequired: false,
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
    sessionId: string;
    deviceId: string;
    isNewDevice: boolean;
    forceChangePassword: boolean;
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

    const newHash = await this.passwordService.hash(input.newPassword);
    await this.db
      .update(users)
      .set({ password: newHash, passwordChangedAt: new Date(), isPasswordChangeRequired: false })
      .where(eq(users.id, userId));

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

    const newHash = await this.passwordService.hash(input.newPassword);
    await this.db
      .update(users)
      .set({ password: newHash, passwordChangedAt: new Date(), isPasswordChangeRequired: false })
      .where(eq(users.id, user.id));

    await this.db.delete(passwordResetTokens).where(eq(passwordResetTokens.id, record.id));
    await this.sessionService.revokeAll(user.id);
    await this.cache.invalidate(CACHE_KEYS.userSession(user.id));

    this.audit.log({ action: "auth.password_reset_completed", userId: user.id });
  }

  async verifyEmail(input: VerifyEmailInput): Promise<void> {
    const record = await this.db.query.verificationTokens.findFirst({
      where: and(
        eq(verificationTokens.token, input.token),
        gt(verificationTokens.expires, new Date()),
      ),
    });
    if (!record) throw new BadRequestException("Invalid or expired verification token");

    await this.db
      .update(users)
      .set({ emailVerified: new Date() })
      .where(sql`lower(${users.email}) = ${record.identifier.toLowerCase()}`);

    await this.db
      .delete(verificationTokens)
      .where(eq(verificationTokens.identifier, record.identifier));
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
}
