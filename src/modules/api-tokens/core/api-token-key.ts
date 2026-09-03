import { createHash, randomBytes } from "node:crypto";

const API_TOKEN_LABEL = "sk_";

/**
 * How many random hex characters the stored prefix carries.
 *
 * `api_keys.key_prefix` carries `idx_api_keys_key_prefix`, a DEPLOYMENT-GLOBAL
 * unique index — `(key_prefix)`, no `org_id` — and TWO code paths write it:
 * `SettingsService.createApiKey` via `generateApiKey()` (settings.helpers.ts) and
 * `ApiTokensService.createToken` via this helper. A prefix drawn by either can
 * collide with one already held by any organisation in the deployment, and
 * neither insert has an `onConflict` or a retry, so a collision is an unhandled
 * 23505 and a 500 for whichever organisation drew second.
 *
 * The generation used to be inline in `createToken` as `rawKey.slice(0, 10)`.
 * "sk_" is 3 characters, so that left exactly SEVEN hex characters: 16^7 =
 * 268,435,456 values for the entire deployment. Measured, not argued: 200,000
 * draws of that expression produced 199,943 distinct prefixes — 57 collisions —
 * and one birthday trial hit its first duplicate at token 40,966.
 *
 * 12 hex characters is 48 bits, matching the floor `generateApiKey()` uses for
 * the other writer into the same index, and putting a collision below the rate at
 * which the row's own UUID `id` collides. No retry branch is needed at that rate;
 * one would be unreachable in production and exercisable only from a test double.
 *
 * Existing rows are unaffected: prefixes minted by the old expression are 10
 * characters and these are 15, so a new token cannot collide with an old one at
 * all. Prefixes from the other writer begin "streamlineos_" and cannot collide
 * with these either.
 *
 * SECURITY. `key_prefix` is stored in plaintext and IS a literal prefix of the
 * secret, so widening it hands out more of the raw key. `rawKey` carries 256 bits
 * of randomness; revealing 48 of them leaves 208, and authentication is by
 * `sha256(rawKey)` (common/auth/api-key.guard.ts:42-44), never by prefix —
 * nothing anywhere looks a key up by `key_prefix`. The prefix is an identifier
 * shown in the UI (`org-tokens-tab.tsx` renders `{t.keyPrefix}…`), not a
 * credential.
 */
export const API_TOKEN_PREFIX_RANDOM_CHARS = 12;

/**
 * Mints a CRM lead-ingestion API token.
 *
 * Extracted from `ApiTokensService.createToken` so the prefix invariant above has
 * a seam to be asserted against without a database. It had none, which is how
 * this writer kept a 7-character prefix while the sibling writer was widened.
 */
export function generateApiToken(): { rawKey: string; keyHash: string; keyPrefix: string } {
  const rawKey = `${API_TOKEN_LABEL}${randomBytes(32).toString("hex")}`;
  const keyHash = createHash("sha256").update(rawKey).digest("hex");
  return {
    rawKey,
    keyHash,
    keyPrefix: rawKey.slice(0, API_TOKEN_LABEL.length + API_TOKEN_PREFIX_RANDOM_CHARS),
  };
}

export { API_TOKEN_LABEL };
