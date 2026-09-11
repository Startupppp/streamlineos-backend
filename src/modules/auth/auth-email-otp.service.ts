import {
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { and, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { addMinutes, subDays } from "date-fns";
import { emailOtpCodes, magicLinkTokens, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { EmailService } from "../email/email.service";
import { hashToken } from "../../common/security/token.util";
import { logger } from "../../common/logger/logger.service";
import { findOrCreateUser, generateToken, serializeEmailError } from "./auth-passwordless.utils";

@Injectable()
export class AuthEmailOtpService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly email: EmailService,
  ) {}

  async requestEmailOtp(email: string): Promise<void> {
    const user = await findOrCreateUser(this.db, email);

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
