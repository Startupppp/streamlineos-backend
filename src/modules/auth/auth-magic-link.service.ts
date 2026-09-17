import {
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { addHours, subDays } from "date-fns";
import { magicLinkTokens, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { EmailService } from "../email/email.service";
import { hashToken } from "../../common/security/token.util";
import { logger } from "../../common/logger/logger.service";
import { AuthMembershipResolverService } from "./auth-membership-resolver.service";
import { AuthAnalyticsService } from "./auth-analytics.service";
import { findOrCreateUser, generateToken, serializeEmailError } from "./auth-passwordless.utils";
import type { MagicLinkRequestInput } from "./dto/auth.schemas";

@Injectable()
export class AuthMagicLinkService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly email: EmailService,
    private readonly membershipResolver: AuthMembershipResolverService,
    private readonly analytics: AuthAnalyticsService,
  ) {}

  async requestMagicLink(input: MagicLinkRequestInput): Promise<void> {
    const user = await findOrCreateUser(this.db, input.email);

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
    const [claimed] = await this.db
      .update(magicLinkTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(magicLinkTokens.id, row.id),
          isNull(magicLinkTokens.usedAt),
          gt(magicLinkTokens.expiresAt, sql`now()`),
        ),
      )
      .returning({ id: magicLinkTokens.id });

    if (!claimed) {
      const reason = row.usedAt !== null ? "token_already_used" : "token_expired";
      await this.analytics.logLoginEvent(
        row.userId,
        null,
        "magic_link.verify",
        false,
        reason,
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

    const membership = await this.membershipResolver.resolveActiveMembership(row.userId, preferredOrgId ?? null);
    const sessionId = await this.membershipResolver.createLoginSession(
      row.userId,
      context,
      membership?.maxConcurrentSessions ?? null,
    );

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
}
