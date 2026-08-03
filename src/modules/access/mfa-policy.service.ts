import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { organizations, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { logger } from "../../common/logger/logger.service";
import type { MfaState } from "./access.types";

const UNDETERMINED: MfaState = { enforced: false, satisfied: true };

@Injectable()
export class MfaPolicyService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async resolve(orgId: string, userId: string): Promise<MfaState> {
    try {
      const [enforced, satisfied] = await Promise.all([
        this.isEnforcedByOrg(orgId),
        this.hasTotp(userId),
      ]);
      return { enforced, satisfied };
    } catch (error) {
      logger.error("Failed to resolve MFA policy", { error, orgId, userId });
      return UNDETERMINED;
    }
  }

  async invalidateOrg(orgId: string): Promise<void> {
    await this.cache.invalidate(CACHE_KEYS.mfaOrgPolicy(orgId));
  }

  async invalidateUser(userId: string): Promise<void> {
    await this.cache.invalidate(CACHE_KEYS.mfaUserTotp(userId));
  }

  private async isEnforcedByOrg(orgId: string): Promise<boolean> {
    if (!orgId) return false;
    return this.cache.cached(
      CACHE_KEYS.mfaOrgPolicy(orgId),
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
