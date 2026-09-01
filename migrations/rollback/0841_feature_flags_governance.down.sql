-- Rollback for 0841_feature_flags_governance.sql
-- CAUTION: owner column data is lost on rollback.
-- After rollback, also revert feature-flags.ts to remove .notNull() from
-- expiresAt and remove the owner field, or the next db:generate will re-propose
-- the forward migration.

ALTER TABLE feature_flags ALTER COLUMN expires_at DROP NOT NULL;

ALTER TABLE feature_flags DROP COLUMN IF EXISTS owner;
