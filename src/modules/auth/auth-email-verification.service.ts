import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
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

  async verifyEmail(input: VerifyEmailInput): Promise<{ autoLoginToken: string }> {
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
}
