import { Injectable, Inject } from "@nestjs/common";
import { and, asc, eq, gt } from "drizzle-orm";
import { candidateSources } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
  maskSecretHint,
} from "../../../../common/security/secret-encryption.util";
import { logger } from "../../../../common/logger/logger.service";
import type { ProviderCredentials } from "./provider-blocked";
import { HR_SCAN_MAX_PAGES, HR_SCAN_PAGE } from "../../hr-read-limits";

/**
 * The one credential store for every recruitment integration.
 *
 * `candidate_sources` already carries `(org_id, platform)` unique, `is_active`,
 * `oauth_token` and a `meta` JSONB, which is exactly the shape ten provider
 * families need — and HR's table count is frozen, so a second store was never
 * an option. The `platform` string namespaces the families (`NAUKRI`,
 * `GOOGLE_CALENDAR`, `WHATSAPP`, `AUTHBRIDGE`, …); nothing else in the row
 * differs between them.
 *
 * Tokens are encrypted at rest with the shared AES-256-GCM helper. The read
 * path falls back to plaintext when the stored value carries no `enc:v1:`
 * prefix, so rows written before this service are still usable and get
 * re-encrypted the next time they are saved — a lazy migration rather than a
 * backfill that would have to guess which columns across the codebase hold a
 * secret.
 */
@Injectable()
export class ProviderCredentialsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * Credentials for one platform, or null when the organisation has no row.
   *
   * Null is the honest answer for "never connected" and is what makes
   * `resolveProvider` able to say `no-integration` rather than `needs-keys`.
   */
  async forPlatform(orgId: string, platform: string): Promise<ProviderCredentials | null> {
    const [row] = await this.db
      .select({
        platform: candidateSources.platform,
        isActive: candidateSources.isActive,
        oauthToken: candidateSources.oauthToken,
        meta: candidateSources.meta,
      })
      .from(candidateSources)
      .where(and(eq(candidateSources.orgId, orgId), eq(candidateSources.platform, platform)))
      .limit(1);
    if (!row) return null;
    return {
      platform: row.platform,
      isActive: row.isActive,
      token: this.read(row.oauthToken, platform),
      meta: row.meta ?? {},
    };
  }

  /** Every connected platform for an organisation, tokens decrypted. */
  async all(orgId: string): Promise<ProviderCredentials[]> {
    const rows = [];
    let afterId = 0;
    for (let page = 0; page < HR_SCAN_MAX_PAGES; page++) {
      const batch = await this.db
        .select({
          id: candidateSources.id,
          platform: candidateSources.platform,
          isActive: candidateSources.isActive,
          oauthToken: candidateSources.oauthToken,
          meta: candidateSources.meta,
        })
        .from(candidateSources)
        .where(and(eq(candidateSources.orgId, orgId), gt(candidateSources.id, afterId)))
        .orderBy(asc(candidateSources.id))
        .limit(HR_SCAN_PAGE);
      rows.push(...batch);
      if (batch.length < HR_SCAN_PAGE) break;
      afterId = batch[batch.length - 1].id;
    }
    return rows.map((row) => ({
      platform: row.platform,
      isActive: row.isActive,
      token: this.read(row.oauthToken, row.platform),
      meta: row.meta ?? {},
    }));
  }

  /**
   * What a settings screen may see: never the token, only whether one is held
   * and the last four characters, so a recruiter can tell two keys apart
   * without the screen becoming a way to read them back out.
   */
  async listForDisplay(orgId: string) {
    const rows = await this.all(orgId);
    return rows.map((row) => ({
      platform: row.platform,
      isActive: row.isActive,
      hasCredentials: row.token !== null,
      credentialHint: row.token ? maskSecretHint(row.token) : null,
      meta: row.meta,
    }));
  }

  private read(stored: string | null, platform: string): string | null {
    if (!stored) return null;
    if (!isEncryptedSecret(stored)) return stored;
    try {
      return decryptSecret(stored);
    } catch (error) {
      /**
       * A token that will not decrypt is worse than no token: it would be sent
       * to a provider as garbage. Report it as absent so the caller blocks with
       * `needs-keys`, and say so loudly rather than swallowing it.
       */
      logger.error("recruitment integration credential failed to decrypt", {
        platform,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** Encrypt on the way in. Callers hand plaintext and never see storage. */
  static seal(token: string | null): string | null {
    if (!token) return null;
    return encryptSecret(token);
  }
}
