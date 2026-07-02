import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { and, desc, eq, gt, gte, sql } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import {
  accounts,
  loginHistory,
  magicLinkTokens,
  organizationMembers,
  organizations,
  passwordResetTokens,
  userSessions,
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
import { SessionService } from "./session.service";
import { hashToken } from "../../common/security/token.util";
import { addHours, addMinutes, subDays } from "date-fns";
import type {
  ForgotPasswordInput,
  GoogleOAuthInput,
  MagicLinkRequestInput,
  ResetPasswordInput,
  VerifyEmailInput,
} from "./dto/auth.schemas";

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

function assertPasswordNotEmail(password: string, email: string): void {
  if (password.toLowerCase() === email.toLowerCase()) {
    throw new BadRequestException("Password cannot be the same as your email address");
  }
}

@Injectable()
export class AuthTokensService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    private readonly password: PasswordService,
    private readonly session: SessionService,
  ) {}

  async resolveActiveMembership(
    userId: string,
    preferredOrgId: string | null,
  ): Promise<{
    orgId: string;
    isOwner: boolean;
    mfaEnforced: boolean;
    enabledModules: string[] | null;
    orgOnboardingCompletedAt: Date | null;
  } | null> {
    const rows = await this.db
      .select({
        orgId: organizationMembers.orgId,
        isOwner: organizationMembers.isOwner,
        mfaEnforced: organizations.mfaEnforced,
        enabledModules: organizations.enabledModules,
        orgOnboardingCompletedAt: organizations.onboardingCompletedAt,
      })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
      .where(eq(organizationMembers.userId, userId))
      .orderBy(desc(organizationMembers.joinedAt));

    if (preferredOrgId) {
      const preferred = rows.find((r) => r.orgId === preferredOrgId);
      if (preferred) return preferred;
    }
    return rows[0] ?? null;
  }

  async logLoginEvent(
    userId: string | null,
    orgId: string | null,
    event: string,
    success: boolean,
    failureReason: string | null,
    context: { ipAddress?: string; userAgent?: string },
  ): Promise<void> {
    if (!userId) return;
    await this.db
      .insert(loginHistory)
      .values({
        id: randomUUID(),
        userId,
        orgId,
        event,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        success,
        failureReason,
      })
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

    await this.db.delete(passwordResetTokens).where(eq(passwordResetTokens.email, normalizedEmail));

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
      where: eq(passwordResetTokens.token, tokenHash),
    });
    if (!record) {
      throw new BadRequestException({ code: "AUTH_TOKEN_INVALID", message: "Invalid reset token" });
    }
    if (new Date(record.expiresAt) <= new Date()) {
      throw new BadRequestException({ code: "AUTH_TOKEN_EXPIRED", message: "Password reset token has expired" });
    }

    const user = await this.db.query.users.findFirst({
      where: sql`lower(${users.email}) = ${record.email.toLowerCase()}`,
    });
    if (!user) throw new NotFoundException("User not found");

    assertPasswordNotEmail(input.newPassword, record.email);
    await this.password.checkPasswordHistory(user.id, input.newPassword);

    const newHash = await this.password.hash(input.newPassword);
    await this.db
      .update(users)
      .set({ password: newHash, passwordChangedAt: new Date(), isPasswordChangeRequired: false })
      .where(eq(users.id, user.id));
    await this.password.recordPasswordHistory(user.id, newHash);

    await this.db.delete(passwordResetTokens).where(eq(passwordResetTokens.id, record.id));
    await this.session.revokeAll(user.id);
    await this.cache.invalidate(CACHE_KEYS.userSession(user.id));

    this.audit.log({ action: "auth.password_reset_completed", userId: user.id });
  }

  async verifyEmail(input: VerifyEmailInput): Promise<{ autoLoginToken: string }> {
    const record = await this.db.query.verificationTokens.findFirst({
      where: eq(verificationTokens.token, hashToken(input.token)),
    });
    if (!record) {
      throw new BadRequestException({ code: "AUTH_TOKEN_INVALID", message: "Invalid verification token" });
    }
    if (new Date(record.expires) <= new Date()) {
      throw new BadRequestException({ code: "AUTH_TOKEN_EXPIRED", message: "Verification token has expired" });
    }

    const [updatedUsers] = await Promise.all([
      this.db
        .update(users)
        .set({ emailVerified: new Date() })
        .where(sql`lower(${users.email}) = ${record.identifier.toLowerCase()}`)
        .returning({ id: users.id }),
      this.db.delete(verificationTokens).where(eq(verificationTokens.identifier, record.identifier)),
    ]);

    const userId = updatedUsers[0]?.id;
    if (!userId) throw new BadRequestException("User not found");

    const rawToken = generateToken();
    const tokenHash = hashToken(rawToken);
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
        "Could not send verification email. Check email configuration and try again.",
      );
    }
  }

  async requestMagicLink(input: MagicLinkRequestInput): Promise<void> {
    const user = await this.db.query.users.findFirst({
      where: sql`lower(${users.email}) = ${input.email.toLowerCase()}`,
      columns: { id: true, email: true, emailVerified: true },
    });

    if (!user || !user.emailVerified) return;

    const token = generateToken();
    const tokenHash = hashToken(token);
    const expiresAt = addHours(new Date(), 1);

    await this.db.insert(magicLinkTokens).values({
      id: randomUUID(),
      userId: user.id,
      tokenHash,
      expiresAt,
    });

    await this.email.sendMagicLinkEmail(user.email, token);
  }

  async verifyMagicLink(token: string): Promise<{ userId: string; orgId: string; forceChangePassword: boolean }> {
    const tokenHash = hashToken(token);

    const row = await this.db.query.magicLinkTokens.findFirst({
      where: eq(magicLinkTokens.tokenHash, tokenHash),
    });

    if (!row) {
      throw new UnauthorizedException({ code: "AUTH_TOKEN_INVALID", message: "Invalid magic link" });
    }
    if (row.usedAt || new Date(row.expiresAt) <= new Date()) {
      throw new UnauthorizedException({
        code: "AUTH_TOKEN_EXPIRED",
        message: "Magic link has expired or has already been used",
      });
    }

    await this.db.update(magicLinkTokens).set({ usedAt: new Date() }).where(eq(magicLinkTokens.id, row.id));

    const user = await this.db.query.users.findFirst({
      where: eq(users.id, row.userId),
      columns: { isPasswordChangeRequired: true, lastActiveOrgId: true },
    });

    const membership = await this.resolveActiveMembership(row.userId, user?.lastActiveOrgId ?? null);

    await this.cache.invalidate(CACHE_KEYS.userSession(row.userId));

    return {
      userId: row.userId,
      orgId: membership?.orgId ?? "",
      forceChangePassword: user?.isPasswordChangeRequired ?? false,
    };
  }

  async getAuditAnalytics(): Promise<{
    loginsToday: number;
    failedLoginsLast7Days: number;
    activeSessions: number;
    passwordResetsLast7Days: number;
  }> {
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
          .where(and(eq(userSessions.isRevoked, false), gt(userSessions.expiresAt, now))),
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
      await this.db
        .insert(accounts)
        .values({
          userId: existingUser.id,
          type: "oauth",
          provider: "google",
          providerAccountId: input.googleId,
        })
        .onConflictDoNothing();

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
