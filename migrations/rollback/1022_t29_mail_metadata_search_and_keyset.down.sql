-- 1022 DOWN -- drops the mail keyset index, the trigram search index and the
-- SECURITY DEFINER search helper. Reverting this returns mail search to a
-- leading-wildcard ILIKE that no index on this table can serve under RLS,
-- and returns list paging to a (date) order with no tiebreak.

SET lock_timeout = '5s';
--> statement-breakpoint

DROP FUNCTION IF EXISTS app.search_mail_message_ids(text, integer, text, integer);
--> statement-breakpoint

DROP INDEX IF EXISTS public."idx_mail_metadata_search_trgm";
--> statement-breakpoint

DROP INDEX IF EXISTS public."idx_mail_metadata_list_keyset";
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_mail_metadata_list"
  ON "mail_message_metadata" ("org_id", "user_membership_id", "folder", "date" DESC);
