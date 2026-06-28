import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, gt } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import {
  users,
  organizations,
  organizationMembers,
  passwordResetTokens,
  verificationTokens,
} from "../../db/schema";
import { EmailService } from "../email/email.service";
import type {
  ForgotPasswordInput,
  RegisterInput,
  ResendVerificationInput,
  ResetPasswordInput,
  VerifyEmailInput,
} from "./dto/auth.schemas";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? process.env.NEXTAUTH_URL ?? "http://localhost:3000";

@Injectable()
export class AuthService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly email: EmailService,
  ) {}

  async register(input: RegisterInput): Promise<{ success: true }> {
    const existing = await this.db.query.users.findFirst({
      where: eq(users.email, input.email.toLowerCase()),
      columns: { id: true },
    });

    if (existing) throw new ConflictException("Email already in use");

    const orgId = crypto.randomUUID();
    const orgSlug = input.organizationName.toLowerCase().replace(/[^a-z0-9]+/g, "-");

    await this.db.insert(organizations).values({
      id: orgId,
      name: input.organizationName,
      slug: orgSlug,
    });

    const userId = crypto.randomUUID();
    const passwordHash = await bcrypt.hash(input.password, 12);

    await this.db.insert(users).values({
      id: userId,
      email: input.email.toLowerCase(),
      password: passwordHash,
      name: `${input.firstName} ${input.lastName}`,
      firstName: input.firstName,
      lastName: input.lastName,
      isActive: true,
    });

    await this.db.insert(organizationMembers).values({
      userId,
      orgId,
      role: "OWNER",
      isOwner: true,
    });

    const verificationToken = crypto.randomUUID();
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await this.db.insert(verificationTokens).values({
      identifier: input.email.toLowerCase(),
      token: verificationToken,
      expires,
    });

    await this.email.sendWelcomeEmail(
      input.email.toLowerCase(),
      `${input.firstName} ${input.lastName}`,
      `${APP_URL}/verify-email?token=${verificationToken}&identifier=${encodeURIComponent(input.email.toLowerCase())}`,
    );

    return { success: true };
  }

  async forgotPassword(input: ForgotPasswordInput): Promise<{ success: true }> {
    const user = await this.db.query.users.findFirst({
      where: eq(users.email, input.email.toLowerCase()),
      columns: { id: true, email: true },
    });

    if (!user) return { success: true };

    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    await this.db
      .delete(passwordResetTokens)
      .where(eq(passwordResetTokens.email, user.email));

    await this.db.insert(passwordResetTokens).values({
      id: crypto.randomUUID(),
      token,
      email: user.email,
      expiresAt,
    });

    await this.email.sendPasswordResetEmail(user.email, token);

    return { success: true };
  }

  async resetPassword(input: ResetPasswordInput): Promise<{ success: true }> {
    const tokenRecord = await this.db.query.passwordResetTokens.findFirst({
      where: and(
        eq(passwordResetTokens.token, input.token),
        gt(passwordResetTokens.expiresAt, new Date()),
      ),
    });

    if (!tokenRecord) throw new BadRequestException("Invalid or expired token");

    const user = await this.db.query.users.findFirst({
      where: eq(users.email, tokenRecord.email),
      columns: { id: true },
    });

    if (!user) throw new NotFoundException("User not found");

    const passwordHash = await bcrypt.hash(input.password, 12);

    await this.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ password: passwordHash, passwordChangedAt: new Date() })
        .where(eq(users.id, user.id));

      await tx
        .delete(passwordResetTokens)
        .where(eq(passwordResetTokens.token, input.token));
    });

    return { success: true };
  }

  async verifyEmail(input: VerifyEmailInput): Promise<{ success: true }> {
    const record = await this.db.query.verificationTokens.findFirst({
      where: and(
        eq(verificationTokens.identifier, input.identifier),
        eq(verificationTokens.token, input.token),
        gt(verificationTokens.expires, new Date()),
      ),
    });

    if (!record) throw new BadRequestException("Invalid or expired token");

    await this.db
      .update(users)
      .set({ emailVerified: new Date() })
      .where(eq(users.email, input.identifier));

    await this.db
      .delete(verificationTokens)
      .where(
        and(
          eq(verificationTokens.identifier, input.identifier),
          eq(verificationTokens.token, input.token),
        ),
      );

    return { success: true };
  }

  async resendVerification(input: ResendVerificationInput): Promise<{ success: true }> {
    const user = await this.db.query.users.findFirst({
      where: eq(users.email, input.email.toLowerCase()),
      columns: { id: true, email: true, emailVerified: true },
    });

    if (!user || user.emailVerified) return { success: true };

    const token = crypto.randomUUID();
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await this.db
      .delete(verificationTokens)
      .where(eq(verificationTokens.identifier, user.email));

    await this.db.insert(verificationTokens).values({
      identifier: user.email,
      token,
      expires,
    });

    await this.email.sendVerificationEmail(user.email, token);

    return { success: true };
  }
}
