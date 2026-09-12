import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { and, eq, gt, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { addHours, addMinutes } from "date-fns";
import { magicLinkTokens, users, verificationTokens } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { EmailService } from "../email/email.service";
import { hashToken } from "../../common/security/token.util";
import { generateToken } from "./auth-passwordless.utils";
import type { VerifyEmailInput } from "./dto/auth.schemas";

@Injectable()
export class AuthEmailVerificationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly email: EmailService,
  ) {}

  async verifyEmail(
    input: VerifyEmailInput,
  ): Promise<{ autoLoginToken: string }> {
    const tokenHash = hashToken(input.token);
    const rawToken = generateToken();
    const autoLoginTokenHash = hashToken(rawToken);
    const expiresAt = addMinutes(new Date(), 5);

    await this.db.transaction(async (tx) => {
      const [claimed] = await tx
        .delete(verificationTokens)
        .where(
          and(
            eq(verificationTokens.token, tokenHash),
            gt(verificationTokens.expires, sql`now()`),
          ),
        )
        .returning();

      if (!claimed)
        throw new BadRequestException({
          code: "AUTH_TOKEN_INVALID",
          message: "Invalid or expired verification token",
        });

      const identifier = claimed.identifier.toLowerCase();

      const user = await tx.query.users.findFirst({
        where: sql`lower(${users.email}) = ${identifier}`,
        columns: { id: true, isActive: true, deletedAt: true },
      });

      if (!user || !user.isActive || user.deletedAt !== null)
        throw new BadRequestException({
          code: "AUTH_TOKEN_INVALID",
          message: "Invalid or expired verification token",
        });

      await tx
        .update(users)
        .set({ emailVerified: new Date() })
        .where(sql`lower(${users.email}) = ${identifier}`);

      await tx.insert(magicLinkTokens).values({
        id: randomUUID(),
        userId: user.id,
        tokenHash: autoLoginTokenHash,
        expiresAt,
      });
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
}
