-- 1021 DOWN -- drops the record-link partial unique index.
--
-- @data-loss on the way FORWARD, not on the way back: 1021's DELETE removes
-- duplicate record links before creating the index, and this rollback cannot
-- resurrect them. Dropping the index itself is lossless and returns
-- KbPageRecordLinksService.add to its unguarded read-then-insert.

SET lock_timeout = '5s';
--> statement-breakpoint

DROP INDEX IF EXISTS public."uniq_kb_page_links_org_source_record";
