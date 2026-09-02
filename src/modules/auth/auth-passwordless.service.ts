import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { and, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import {
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { addHours, addMinutes, subDays } from "date-fns";
import {
  emailOtpCodes,
  magicLinkTokens,
  users,
  verificationTokens,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { EmailService } from "../email/email.service";
import { hashToken } from "../../common/security/token.util";
import { logger } from "../../common/logger/logger.service";
import { AuthMembershipResolverService } from "./auth-membership-resolver.service";
import { AuthAnalyticsService } from "./auth-analytics.service";
import type {
  MagicLinkRequestInput,
  VerifyEmailInput,
} from "./dto/auth.schemas";

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" ? value : undefined;
}

function serializeEmailError(error: unknown): Record<string, unknown> {
  if (!isRecord(error)) return { message: String(error) };
  const cause = isRecord(error.cause) ? error.cause : null;
  const causeStatus = cause?.statusCode;
  return {
    name: stringField(error, "name"),
    message: stringField(error, "message") ?? String(error),
    permanent: typeof error.permanent === "boolean" ? error.permanent : undefined,
    causeMessage: cause ? stringField(cause, "message") : undefined,
    causeStatus: typeof causeStatus === "number" ? causeStatus : undefined,
    causeName: cause ? stringField(cause, "name") : undefined,
  };
}

@Injectable()
export class AuthPasswordlessService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly email: EmailService,
    private readonly membershipResolver: AuthMembershipResolverService,
    private readonly analytics: AuthAnalyticsService,
  ) {}

  private async findOrCreateUser(
    email: string,
  ): Promise<{ id: string; email: string }> {
    const normalizedEmail = email.toLowerCase().trim();

    const existing = await this.db.query.users.findFirst({
      where: sql`lower(${users.email}) = ${normalizedEmail}`,
      columns: { id: true, email: true },
    });
    if (existing) return existing;

    const displayName = normalizedEmail.split("@")[0] || normalizedEmail;
    const [created] = await this.db
      .insert(users)
      .values({
        id: randomUUID(),
        email: normalizedEmail,
        name: displayName,
        firstName: displayName,
        lastName: "",
        isActive: true,
        emailVerified: null,
      })
      .onConflictDoNothing()
      .returning({ id: users.id, email: users.email });
    if (created) return created;

    const row = await this.db.query.users.findFirst({
      where: sql`lower(${users.email}) = ${normalizedEmail}`,
      columns: { id: true, email: true },
    });
    if (!row)
      throw new ServiceUnavailableException(
        "Could not start sign-in. Please try again.",
      );
    return row;
  }

  async verifyEmail(
    input: VerifyEmailInput,
  ): Promise<{ autoLoginToken: string }> {
    const record = await this.db.query.verificationTokens.findFirst({
      where: eq(verificationTokens.token, hashToken(input.token)),
    });
    if (!record) {
      throw new BadRequestException({
        code: "AUTH_TOKEN_INVALID",
        message: "Invalid verification token",
      });
    }
    if (new Date(record.expires) <= new Date()) {
      throw new BadRequestException({
        code: "AUTH_TOKEN_EXPIRED",
        message: "Verification token has expired",
      });
    }

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

    await this.db
      .delete(verificationTokens)
      .where(eq(verificationTokens.identifier, normalizedEmail));

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
    const user = await this.findOrCreateUser(input.email);

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
        .where(
          and(
            eq(magicLinkTokens.userId, user.id),
            lt(magicLinkTokens.expiresAt, subDays(new Date(), 1)),
          ),
        ),
    ]);

    try {
      await this.email.sendMagicLinkEmail(user.email, token);
    } catch (error: unknown) {
      await this.db
        .update(magicLinkTokens)
        .set({ usedAt: new Date() })
        .where(and(eq(magicLinkTokens.tokenHash, tokenHash), isNull(magicLinkTokens.usedAt)));
      logger.error("Magic link email send failed", {
        userId: user.id,
        error: serializeEmailError(error),
      });
      throw new ServiceUnavailableException(
        "Could not send the sign-in link. Please try again in a moment.",
      );
    }
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
      throw new UnauthorizedException({
        code: "AUTH_TOKEN_INVALID",
        message: "Invalid magic link",
      });
    }
    if (new Date(row.expiresAt) <= new Date()) {
      await this.analytics.logLoginEvent(
        row.userId,
        null,
        "magic_link.verify",
        false,
        "token_expired",
        context,
      );
      throw new UnauthorizedException({
        code: "AUTH_TOKEN_EXPIRED",
        message: "Magic link has expired or has already been used",
      });
    }

    const [claimed] = await this.db
      .update(magicLinkTokens)
      .set({ usedAt: new Date() })
      .where(
        and(eq(magicLinkTokens.id, row.id), isNull(magicLinkTokens.usedAt)),
      )
      .returning({ id: magicLinkTokens.id });

    if (!claimed) {
      await this.analytics.logLoginEvent(
        row.userId,
        null,
        "magic_link.verify",
        false,
        "token_already_used",
        context,
      );
      throw new UnauthorizedException({
        code: "AUTH_TOKEN_EXPIRED",
        message: "Magic link has expired or has already been used",
      });
    }

    const user = await this.db.query.users.findFirst({
      where: eq(users.id, row.userId),
      columns: { isActive: true, deletedAt: true },
    });

    if (!user || !user.isActive || user.deletedAt !== null) {
      await this.analytics.logLoginEvent(
        row.userId,
        null,
        "magic_link.verify",
        false,
        "account_inactive",
        context,
      );
      throw new UnauthorizedException({
        code: "AUTH_TOKEN_INVALID",
        message: "Invalid or expired credentials",
      });
    }

    await this.db
      .update(users)
      .set({ emailVerified: new Date() })
      .where(and(eq(users.id, row.userId), isNull(users.emailVerified)));

    const preferredOrgId = await this.membershipResolver
      .resolvePreferredOrgId(row.userId)
      .catch(() => null);

    const [membership, sessionId] = await Promise.all([
      this.membershipResolver.resolveActiveMembership(row.userId, preferredOrgId ?? null),
      this.membershipResolver.createLoginSession(row.userId, context),
    ]);

    await Promise.all([
      this.cache.invalidate(CACHE_KEYS.userSession(row.userId)),
      this.analytics.logLoginEvent(
        row.userId,
        membership?.orgId ?? null,
        "magic_link.verify",
        true,
        null,
        context,
      ),
    ]);

    return {
      userId: row.userId,
      orgId: membership?.orgId ?? "",
      sessionId,
    };
  }

  async requestEmailOtp(email: string): Promise<void> {
    const user = await this.findOrCreateUser(email);

    const rawCode = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const codeHash = hashToken(rawCode);
    const expiresAt = addMinutes(new Date(), 10);

    await Promise.all([
      this.db
        .update(emailOtpCodes)
        .set({ usedAt: new Date() })
        .where(
          and(eq(emailOtpCodes.userId, user.id), isNull(emailOtpCodes.usedAt)),
        ),
      this.db
        .delete(emailOtpCodes)
        .where(
          and(
            eq(emailOtpCodes.userId, user.id),
            lt(emailOtpCodes.expiresAt, subDays(new Date(), 1)),
          ),
        ),
    ]);

    const [inserted] = await this.db
      .insert(emailOtpCodes)
      .values({ userId: user.id, codeHash, expiresAt })
      .returning({ id: emailOtpCodes.id });

    try {
      await this.email.sendEmailOtpEmail(user.email, rawCode);
    } catch (error: unknown) {
      if (inserted) {
        await this.db
          .update(emailOtpCodes)
          .set({ usedAt: new Date() })
          .where(eq(emailOtpCodes.id, inserted.id));
      }
      logger.error("Email OTP send failed", {
        userId: user.id,
        error: serializeEmailError(error),
      });
      throw new ServiceUnavailableException(
        "Could not send the sign-in code. Please try again in a moment.",
      );
    }
  }

  async verifyEmailOtp(
    email: string,
    code: string,
  ): Promise<{ autoLoginToken: string }> {
    const normalizedEmail = email.toLowerCase().trim();
    const normalizedCode = code.trim();

    const user = await this.db.query.users.findFirst({
      where: sql`lower(${users.email}) = ${normalizedEmail}`,
      columns: { id: true, isActive: true, deletedAt: true },
    });

    if (!user) throw new UnauthorizedException("Invalid or expired code");
    if (!user.isActive || user.deletedAt !== null)
      throw new UnauthorizedException("Invalid or expired code");

    const row = await this.db.query.emailOtpCodes.findFirst({
      where: and(
        eq(emailOtpCodes.userId, user.id),
        isNull(emailOtpCodes.usedAt),
        gt(emailOtpCodes.expiresAt, sql`now()`),
      ),
      orderBy: [desc(emailOtpCodes.createdAt)],
    });

    if (!row) throw new UnauthorizedException("Invalid or expired code");

    const [bumped] = await this.db
      .update(emailOtpCodes)
      .set({ attempts: sql`${emailOtpCodes.attempts} + 1` })
      .where(and(eq(emailOtpCodes.id, row.id), isNull(emailOtpCodes.usedAt)))
      .returning({ attempts: emailOtpCodes.attempts });

    if (!bumped || bumped.attempts > 5)
      throw new UnauthorizedException("Invalid or expired code");

    const submittedHash = Buffer.from(hashToken(normalizedCode), "hex");
    const expectedHash = Buffer.from(row.codeHash, "hex");
    const codeMatches =
      submittedHash.length === expectedHash.length &&
      timingSafeEqual(submittedHash, expectedHash);
    if (!codeMatches) throw new UnauthorizedException("Invalid or expired code");

    const [updated] = await this.db
      .update(emailOtpCodes)
      .set({ usedAt: new Date() })
      .where(and(eq(emailOtpCodes.id, row.id), isNull(emailOtpCodes.usedAt)))
      .returning({ id: emailOtpCodes.id });

    if (!updated) throw new UnauthorizedException("Invalid or expired code");

    await this.db
      .update(users)
      .set({ emailVerified: new Date() })
      .where(and(eq(users.id, user.id), isNull(users.emailVerified)));

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
}
