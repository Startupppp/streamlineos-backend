-- 0984 DOWN — drop the git webhook seen-delivery deduplication table.
-- Safe to run on a live DB: the table is append-only with no foreign keys
-- referencing it, so DROP TABLE CASCADE is not needed.

SET lock_timeout = '5s';

DROP TABLE IF EXISTS build.git_webhook_seen_deliveries;
