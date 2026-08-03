SET statement_timeout = 0;
SET lock_timeout = '5s';

-- 0390 — PAT hashing switched from bcrypt to SHA-256, soft revoke, and drop the
-- dead NextAuth `sessions` table.
--
-- `hash_alg` marks rows whose plaintext was never stored and therefore cannot be
-- re-hashed; the guard tries the indexed SHA-256 lookup first, then a prefix scan
-- limited to `hash_alg = 'bcrypt'`, rewriting each legacy row on first successful
-- use so the slow path drains without a forced re-issue.
--
-- `sessions` verified before dropping: no symbol reference, no raw table-name
-- reference, no dependent FK. Application sessions live in `user_sessions`.

ALTER TABLE "user_api_tokens"
  ADD COLUMN IF NOT EXISTS "hash_alg" text DEFAULT 'bcrypt' NOT NULL;
--> statement-breakpoint

ALTER TABLE "user_api_tokens"
  ADD COLUMN IF NOT EXISTS "revoked_at" timestamp;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_user_api_tokens_legacy_lookup"
  ON "user_api_tokens" ("prefix", "hash_alg");
--> statement-breakpoint

DROP TABLE IF EXISTS "sessions";
