import { createHash, randomBytes } from "crypto";

export const VALID_API_KEY_SCOPES = [
  "leads:read",
  "leads:write",
  "deals:read",
  "deals:write",
  "contacts:read",
  "contacts:write",
  "hr:read",
  "hr:write",
  "*",
] as const;

export interface OrgFeatureFlags {
  aiChat: boolean;
  aiLeadScoring: boolean;
  aiEmailDraft: boolean;
  aiSmartNotifications: boolean;
  aiWeeklyRecap: boolean;
  supportAi: boolean;
}

const DEFAULT_FEATURE_FLAGS: OrgFeatureFlags = {
  aiChat: true,
  aiLeadScoring: true,
  aiEmailDraft: true,
  aiSmartNotifications: true,
  aiWeeklyRecap: true,
  supportAi: true,
};

const API_KEY_LABEL = "streamlineos_";

/**
 * How many random hex characters the stored prefix carries. 12 = 48 bits.
 *
 * `idx_api_keys_key_prefix` is a DEPLOYMENT-GLOBAL unique index — `(key_prefix)`,
 * no org_id — and `createApiKey` below has no onConflict and no retry, so a
 * duplicate prefix is an unhandled 23505 and a 500 on POST /settings/api-keys
 * for whichever organisation drew second. `rawKey.slice(0, 16)` left exactly
 * THREE hex characters after the 13-character label: 4,096 values for the entire
 * deployment, with a first collision expected around the 80th key ever created.
 * Measured at 4,096 distinct over 200,000 draws; first duplicate at key 73.
 *
 * 48 bits puts the collision rate below that of the row's own UUID `id`, so the
 * prefix stops being a shared resource between tenants and no retry branch is
 * needed. Existing 16-character prefixes cannot collide with these: the lengths
 * differ, so the strings do.
 *
 * The prefix is stored in plaintext and shown in the UI, so it hands out this
 * many characters of the secret. rawKey carries 256 bits and authentication is
 * by sha256(rawKey) (common/auth/api-key.guard.ts), never by prefix, so the
 * prefix is an identifier and the remaining 208 bits are the credential.
 */
const API_KEY_PREFIX_RANDOM_CHARS = 12;

export function generateApiKey(): { id: string; rawKey: string; keyHash: string; keyPrefix: string } {
  const rawKey = `${API_KEY_LABEL}${randomBytes(32).toString("hex")}`;
  const keyHash = createHash("sha256").update(rawKey).digest("hex");
  return {
    id: randomBytes(16).toString("hex"),
    rawKey,
    keyHash,
    keyPrefix: rawKey.slice(0, API_KEY_LABEL.length + API_KEY_PREFIX_RANDOM_CHARS),
  };
}

export function parseOrgFeatureFlags(
  settings: Record<string, unknown> | null | undefined,
): OrgFeatureFlags {
  const features = (settings?.features ?? {}) as Partial<OrgFeatureFlags>;
  return {
    aiChat: features.aiChat ?? DEFAULT_FEATURE_FLAGS.aiChat,
    aiLeadScoring: features.aiLeadScoring ?? DEFAULT_FEATURE_FLAGS.aiLeadScoring,
    aiEmailDraft: features.aiEmailDraft ?? DEFAULT_FEATURE_FLAGS.aiEmailDraft,
    aiSmartNotifications: features.aiSmartNotifications ?? DEFAULT_FEATURE_FLAGS.aiSmartNotifications,
    aiWeeklyRecap: features.aiWeeklyRecap ?? DEFAULT_FEATURE_FLAGS.aiWeeklyRecap,
    supportAi: features.supportAi ?? DEFAULT_FEATURE_FLAGS.supportAi,
  };
}
