-- Rollback for 1212_kb_indexed_bytes_quota
-- Drops the indexed-bytes accounting table.
-- Safe to run only while no application code references kb_indexed_bytes_quota.
SET lock_timeout = '5s';

DROP TABLE IF EXISTS "public"."kb_indexed_bytes_quota";
