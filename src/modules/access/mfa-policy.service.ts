import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { organizations, users, userSessions } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { logger } from "../../common/logger/logger.service";
import type { MfaState } from "./access.types";
import type { MfaSessionRef } from "../../common/auth/mfa-policy.token";

const UNDETERMINED: MfaState = { enforced: true, satisfied: false };

@Injectable()
export class MfaPolicyService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async resolve(
    orgId: string,
    userId: string,
    session: MfaSessionRef,
  ): Promise<MfaState> {
    try {
      const [enforced, enrolled] = await Promise.all([
        this.isEnforcedByOrg(orgId),
        this.hasTotp(userId),
      ]);
      if (!enforced) return { enforced, satisfied: enrolled };
      if (!enrolled) return { enforced, satisfied: false };
      if (!session.interactive) return { enforced, satisfied: true };
      return {
        enforced,
        satisfied: await this.hasPassedChallenge(session.sessionId),
      };
    } catch (error) {
      logger.error("Failed to resolve MFA policy", { error, orgId, userId });
      return UNDETERMINED;
    }
  }

  async invalidateOrg(orgId: string): Promise<void> {
    await this.cache.invalidateForOrg(orgId, "mfa:org-policy");
  }

  async invalidateUser(userId: string): Promise<void> {
    await this.cache.invalidate(CACHE_KEYS.mfaUserTotp(userId));
  }

  private async isEnforcedByOrg(orgId: string): Promise<boolean> {
    if (!orgId) return false;
    return this.cache.cachedForOrg(
      orgId,
      "mfa:org-policy",
      async () => {
        const org = await this.db.query.organizations.findFirst({
          where: eq(organizations.id, orgId),
          columns: { mfaEnforced: true },
        });
        return org?.mfaEnforced ?? false;
      },
      CACHE_TTL.MEDIUM,
    );
  }

  private async hasPassedChallenge(sessionId: string): Promise<boolean> {
    if (!sessionId) return false;
    const session = await this.db.query.userSessions.findFirst({
      where: eq(userSessions.id, sessionId),
      columns: { mfaSatisfiedAt: true },
    });
    return session?.mfaSatisfiedAt != null;
  }

  private async hasTotp(userId: string): Promise<boolean> {
    return this.cache.cached(
      CACHE_KEYS.mfaUserTotp(userId),
      async () => {
        const user = await this.db.query.users.findFirst({
          where: eq(users.id, userId),
          columns: { totpEnabled: true },
        });
        return user?.totpEnabled ?? false;
      },
      CACHE_TTL.MEDIUM,
    );
  }
}
