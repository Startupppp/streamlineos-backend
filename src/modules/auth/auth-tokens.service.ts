import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { and, desc, eq, gt, gte, isNull, lt, sql } from "drizzle-orm";
import { randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import {
  accounts,
  emailOtpCodes,
  loginHistory,
  magicLinkTokens,
  organizationMembers,
  organizations,
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
import { SessionService } from "./session.service";
import { hashToken } from "../../common/security/token.util";
import { logger } from "../../common/logger/logger.service";
import { addDays, addHours, addMinutes, subDays } from "date-fns";
import type {
  GoogleOAuthInput,
  MagicLinkRequestInput,
  VerifyEmailInput,
} from "./dto/auth.schemas";

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

@Injectable()
export class AuthTokensService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
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

    await Promise.all([
      this.db.insert(magicLinkTokens).values({
        id: randomUUID(),
        userId: user.id,
        tokenHash,
        expiresAt,
      }),
      this.db
        .delete(magicLinkTokens)
        .where(and(eq(magicLinkTokens.userId, user.id), lt(magicLinkTokens.expiresAt, subDays(new Date(), 1)))),
    ]);

    void this.email.sendMagicLinkEmail(user.email, token).catch((error: unknown) => {
      logger.error("Magic link email send failed", { userId: user.id, error });
    });
  }

  async requestEmailOtp(email: string): Promise<void> {
    const normalizedEmail = email.toLowerCase().trim();

    const user = await this.db.query.users.findFirst({
      where: sql`lower(${users.email}) = ${normalizedEmail}`,
      columns: { id: true, email: true, emailVerified: true },
    });

    if (!user || !user.emailVerified) return;

    const rawCode = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const codeHash = hashToken(rawCode);
    const expiresAt = addMinutes(new Date(), 10);

    await Promise.all([
      this.db
        .update(emailOtpCodes)
        .set({ usedAt: new Date() })
        .where(and(eq(emailOtpCodes.userId, user.id), isNull(emailOtpCodes.usedAt))),
      this.db
        .delete(emailOtpCodes)
        .where(and(eq(emailOtpCodes.userId, user.id), lt(emailOtpCodes.expiresAt, subDays(new Date(), 1)))),
    ]);

    await this.db.insert(emailOtpCodes).values({
      userId: user.id,
      codeHash,
      expiresAt,
    });

    void this.email.sendEmailOtpEmail(user.email, rawCode).catch((error: unknown) => {
      logger.error("Email OTP send failed", { userId: user.id, error });
    });
  }

  async verifyEmailOtp(email: string, code: string): Promise<{ autoLoginToken: string }> {
    const normalizedEmail = email.toLowerCase().trim();

    const user = await this.db.query.users.findFirst({
      where: sql`lower(${users.email}) = ${normalizedEmail}`,
      columns: { id: true },
    });

    if (!user) throw new UnauthorizedException("Invalid or expired code");

    const row = await this.db.query.emailOtpCodes.findFirst({
      where: and(
        eq(emailOtpCodes.userId, user.id),
        isNull(emailOtpCodes.usedAt),
        gt(emailOtpCodes.expiresAt, new Date()),
      ),
      orderBy: [desc(emailOtpCodes.createdAt)],
    });

    if (!row) throw new UnauthorizedException("Invalid or expired code");

    const [bumped] = await this.db
      .update(emailOtpCodes)
      .set({ attempts: sql`${emailOtpCodes.attempts} + 1` })
      .where(and(eq(emailOtpCodes.id, row.id), isNull(emailOtpCodes.usedAt)))
      .returning({ attempts: emailOtpCodes.attempts });

    if (!bumped || bumped.attempts > 5) throw new UnauthorizedException("Invalid or expired code");

    const submittedHash = Buffer.from(hashToken(code), "hex");
    const expectedHash = Buffer.from(row.codeHash, "hex");
    const codeMatches =
      submittedHash.length === expectedHash.length && timingSafeEqual(submittedHash, expectedHash);
    if (!codeMatches) throw new UnauthorizedException("Invalid or expired code");

    const [updated] = await this.db
      .update(emailOtpCodes)
      .set({ usedAt: new Date() })
      .where(and(eq(emailOtpCodes.id, row.id), isNull(emailOtpCodes.usedAt)))
      .returning({ id: emailOtpCodes.id });

    if (!updated) throw new UnauthorizedException("Invalid or expired code");

    const rawToken = generateToken();
    const tokenHash = hashToken(rawToken);

    await this.db.insert(magicLinkTokens).values({
      id: randomUUID(),
      userId: user.id,
      tokenHash,
      expiresAt: addMinutes(new Date(), 5),
    });

    return { autoLoginToken: rawToken };
  }

  private async createLoginSession(
    userId: string,
    context: { userAgent?: string; ipAddress?: string },
  ): Promise<string> {
    return this.session.create({
      userId,
      userAgent: context.userAgent,
      ipAddress: context.ipAddress,
      expiresAt: addDays(new Date(), 30),
    });
  }

  async verifyMagicLink(
    token: string,
    context: { userAgent?: string; ipAddress?: string },
  ): Promise<{ userId: string; orgId: string; sessionId: string }> {
    const tokenHash = hashToken(token);

    const row = await this.db.query.magicLinkTokens.findFirst({
      where: eq(magicLinkTokens.tokenHash, tokenHash),
    });

    if (!row) {
      throw new UnauthorizedException({ code: "AUTH_TOKEN_INVALID", message: "Invalid magic link" });
    }
    if (new Date(row.expiresAt) <= new Date()) {
      await this.logLoginEvent(row.userId, null, "magic_link.verify", false, "token_expired", context);
      throw new UnauthorizedException({
        code: "AUTH_TOKEN_EXPIRED",
        message: "Magic link has expired or has already been used",
      });
    }

    const [claimed] = await this.db
      .update(magicLinkTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(magicLinkTokens.id, row.id), isNull(magicLinkTokens.usedAt)))
      .returning({ id: magicLinkTokens.id });

    if (!claimed) {
      await this.logLoginEvent(row.userId, null, "magic_link.verify", false, "token_already_used", context);
      throw new UnauthorizedException({
        code: "AUTH_TOKEN_EXPIRED",
        message: "Magic link has expired or has already been used",
      });
    }

    const user = await this.db.query.users.findFirst({
      where: eq(users.id, row.userId),
      columns: { lastActiveOrgId: true },
    });

    const [membership, sessionId] = await Promise.all([
      this.resolveActiveMembership(row.userId, user?.lastActiveOrgId ?? null),
      this.createLoginSession(row.userId, context),
    ]);

    await Promise.all([
      this.cache.invalidate(CACHE_KEYS.userSession(row.userId)),
      this.logLoginEvent(row.userId, membership?.orgId ?? null, "magic_link.verify", true, null, context),
    ]);

    return {
      userId: row.userId,
      orgId: membership?.orgId ?? "",
      sessionId,
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

    const [loginsTodayResult, failedLoginsResult, activeSessionsResult] =
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
      ]);

    return {
      loginsToday: loginsTodayResult[0]?.count ?? 0,
      failedLoginsLast7Days: failedLoginsResult[0]?.count ?? 0,
      activeSessions: activeSessionsResult[0]?.count ?? 0,
      passwordResetsLast7Days: 0,
    };
  }

  async googleOAuth(
    input: GoogleOAuthInput,
    context: { userAgent?: string; ipAddress?: string },
  ): Promise<{ userId: string; isNewUser: boolean; sessionId: string }> {
    const normalizedEmail = input.email.toLowerCase().trim();

    const existingAccount = await this.db.query.accounts.findFirst({
      where: and(
        eq(accounts.provider, "google"),
        eq(accounts.providerAccountId, input.googleId),
      ),
      columns: { userId: true },
    });

    if (existingAccount) {
      const sessionId = await this.createLoginSession(existingAccount.userId, context);
      void this.logLoginEvent(existingAccount.userId, null, "google_oauth.login", true, null, context);
      return { userId: existingAccount.userId, isNewUser: false, sessionId };
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

      const sessionId = await this.createLoginSession(existingUser.id, context);
      void this.logLoginEvent(existingUser.id, null, "google_oauth.login", true, null, context);
      return { userId: existingUser.id, isNewUser: false, sessionId };
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

    const sessionId = await this.createLoginSession(userId, context);
    void this.logLoginEvent(userId, null, "google_oauth.register", true, null, context);
    return { userId, isNewUser: true, sessionId };
  }
}
