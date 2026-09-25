import {
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { and, desc, eq, gt, isNull, lt, lte, sql } from "drizzle-orm";
import { randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { addMinutes, subDays } from "date-fns";
import { emailOtpCodes, magicLinkTokens, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { EmailService } from "../email/email.service";
import { hashToken } from "../../common/security/token.util";
import { logger } from "../../common/logger/logger.service";
import { findOrCreateUser, generateToken, serializeEmailError } from "./auth-passwordless.utils";

const OTP_MAX_ATTEMPTS = 5;

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

    // Sweeping long-dead rows is housekeeping and is safe anywhere.
    await this.db
      .delete(emailOtpCodes)
      .where(
        and(
          eq(emailOtpCodes.userId, user.id),
          lt(emailOtpCodes.expiresAt, subDays(new Date(), 1)),
        ),
      );

    const [inserted] = await this.db
      .insert(emailOtpCodes)
      .values({ userId: user.id, codeHash, expiresAt })
      .returning({ id: emailOtpCodes.id });

    // HRMS-E2E-023. The earlier codes used to be retired here, BEFORE the send
    // was attempted, and that is what stranded people. A slow code makes someone
    // press Resend — which is the one thing that killed the code already sitting
    // in their inbox — and if the send then failed, the catch below burned the
    // new one too, leaving them with nothing while the screen said a code had
    // been sent. QA saw both halves: seven codes arriving at once, then a
    // valid-looking one refused.
    //
    // Sending first and retiring only on success means a failed send leaves the
    // person exactly as they were. The window where two codes are live is safe
    // by construction: verifyEmailOtp reads the newest unused row and only that
    // one, which auth-email-otp-claim.spec.ts pins as CORRECT-BY-DESIGN.
    //
    // An ordering, not a wrapping transaction — BE-84 forbids a network call
    // inside one.
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

    // Only now, with the new code actually accepted by the provider, do the
    // earlier ones stop working. Outside the try on purpose: a failure here is
    // not a delivery failure, and treating it as one would burn a code the
    // person has already received.
    await this.db
      .update(emailOtpCodes)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(emailOtpCodes.userId, user.id),
          isNull(emailOtpCodes.usedAt),
          // Older than the one just delivered, not merely "not mine". Two
          // resends racing would otherwise retire each other's codes and leave
          // the person with none: A kills B's, B kills A's. Bounded by id, the
          // newer insert survives and the older is retired — which is also the
          // row verifyEmailOtp would have picked anyway, since it reads newest
          // first.
          ...(inserted ? [lt(emailOtpCodes.id, inserted.id)] : []),
        ),
      );
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
      orderBy: [desc(emailOtpCodes.createdAt), desc(emailOtpCodes.id)],
    });

    if (!row) throw new UnauthorizedException("Invalid or expired code");

    const [bumped] = await this.db
      .update(emailOtpCodes)
      .set({ attempts: sql`${emailOtpCodes.attempts} + 1` })
      .where(and(eq(emailOtpCodes.id, row.id), isNull(emailOtpCodes.usedAt)))
      .returning({ attempts: emailOtpCodes.attempts });

    if (!bumped || bumped.attempts > OTP_MAX_ATTEMPTS)
      throw new UnauthorizedException("Invalid or expired code");

    const submittedHash = Buffer.from(hashToken(normalizedCode), "hex");
    const expectedHash = Buffer.from(row.codeHash, "hex");
    const codeMatches =
      submittedHash.length === expectedHash.length &&
      timingSafeEqual(submittedHash, expectedHash);
    if (!codeMatches) throw new UnauthorizedException("Invalid or expired code");

    const rawToken = generateToken();
    const tokenHash = hashToken(rawToken);

    const claimed = await this.db.transaction(async (tx) => {
      const [consumed] = await tx
        .update(emailOtpCodes)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(emailOtpCodes.id, row.id),
            isNull(emailOtpCodes.usedAt),
            gt(emailOtpCodes.expiresAt, sql`now()`),
            lte(emailOtpCodes.attempts, OTP_MAX_ATTEMPTS),
          ),
        )
        .returning({ id: emailOtpCodes.id });

      if (!consumed) return false;

      await tx
        .update(users)
        .set({ emailVerified: new Date() })
        .where(and(eq(users.id, user.id), isNull(users.emailVerified)));

      await tx.insert(magicLinkTokens).values({
        id: randomUUID(),
        userId: user.id,
        tokenHash,
        expiresAt: addMinutes(new Date(), 5),
      });

      return true;
    });

    if (!claimed) throw new UnauthorizedException("Invalid or expired code");

    return { autoLoginToken: rawToken };
  }
}
