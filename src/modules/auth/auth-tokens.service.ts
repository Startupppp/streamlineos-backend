import {
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { accounts, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import type {
  GoogleOAuthInput,
  MagicLinkRequestInput,
  VerifyEmailInput,
} from "./dto/auth.schemas";
import { AuthPasswordlessService } from "./auth-passwordless.service";
import { AuthMembershipResolverService } from "./auth-membership-resolver.service";
import { AuthAnalyticsService } from "./auth-analytics.service";

@Injectable()
export class AuthTokensService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly passwordless: AuthPasswordlessService,
    private readonly membershipResolver: AuthMembershipResolverService,
    private readonly analytics: AuthAnalyticsService,
  ) {}

  async resolveActiveMembership(
    userId: string,
    preferredOrgId: string | null,
    options?: { honorSuspendedPreference?: boolean },
  ) {
    return this.membershipResolver.resolveActiveMembership(
      userId,
      preferredOrgId,
      options,
    );
  }

  async resolveSuspendedMembership(
    userId: string,
    preferredOrgId: string | null,
  ) {
    return this.membershipResolver.resolveSuspendedMembership(
      userId,
      preferredOrgId,
    );
  }

  async verifyEmail(input: VerifyEmailInput) {
    return this.passwordless.verifyEmail(input);
  }

  async resendVerification(email: string) {
    return this.passwordless.resendVerification(email);
  }

  async requestMagicLink(input: MagicLinkRequestInput) {
    return this.passwordless.requestMagicLink(input);
  }

  async verifyMagicLink(
    token: string,
    context: { userAgent?: string; ipAddress?: string },
  ) {
    return this.passwordless.verifyMagicLink(token, context);
  }

  async requestEmailOtp(email: string) {
    return this.passwordless.requestEmailOtp(email);
  }

  async verifyEmailOtp(email: string, code: string) {
    return this.passwordless.verifyEmailOtp(email, code);
  }

  async getAuditAnalytics() {
    return this.analytics.getAuditAnalytics();
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
      const accountUser = await this.db.query.users.findFirst({
        where: eq(users.id, existingAccount.userId),
        columns: { isActive: true, deletedAt: true },
      });
      if (!accountUser || !accountUser.isActive || accountUser.deletedAt !== null) {
        void this.analytics.logLoginEvent(existingAccount.userId, null, "google_oauth.login", false, "account_inactive", context);
        throw new UnauthorizedException("Authentication failed");
      }
      const sessionId = await this.membershipResolver.createLoginSession(
        existingAccount.userId,
        context,
      );
      void this.analytics.logLoginEvent(
        existingAccount.userId,
        null,
        "google_oauth.login",
        true,
        null,
        context,
      );
      return { userId: existingAccount.userId, isNewUser: false, sessionId };
    }

    const existingUser = await this.db.query.users.findFirst({
      where: sql`lower(${users.email}) = ${normalizedEmail}`,
      columns: { id: true, emailVerified: true, isActive: true, deletedAt: true },
    });

    if (existingUser) {
      if (!existingUser.isActive || existingUser.deletedAt !== null) {
        void this.analytics.logLoginEvent(existingUser.id, null, "google_oauth.login", false, "account_inactive", context);
        throw new UnauthorizedException("Authentication failed");
      }
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
        await this.db
          .update(users)
          .set({ emailVerified: new Date() })
          .where(eq(users.id, existingUser.id));
      }

      const sessionId = await this.membershipResolver.createLoginSession(
        existingUser.id,
        context,
      );
      void this.analytics.logLoginEvent(
        existingUser.id,
        null,
        "google_oauth.login",
        true,
        null,
        context,
      );
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
        isActive: true,
        emailVerified: new Date(),
      });

      await tx.insert(accounts).values({
        userId,
        type: "oauth",
        provider: "google",
        providerAccountId: input.googleId,
      });
    });

    this.audit.log({
      action: "user.registered",
      userId,
      metadata: { email: normalizedEmail, provider: "google" },
    });

    const sessionId = await this.membershipResolver.createLoginSession(
      userId,
      context,
    );
    void this.analytics.logLoginEvent(
      userId,
      null,
      "google_oauth.register",
      true,
      null,
      context,
    );
    return { userId, isNewUser: true, sessionId };
  }
}
