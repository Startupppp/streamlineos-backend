-- 0940_ar02_misc_composite_fks DOWN — drops every constraint and index the up migration added.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE kb_article_comments DROP CONSTRAINT IF EXISTS "fk_kb_article_comments_org_parent";
--> statement-breakpoint
ALTER TABLE goals DROP CONSTRAINT IF EXISTS "fk_goals_org_parent";
--> statement-breakpoint
ALTER TABLE documents DROP CONSTRAINT IF EXISTS "fk_documents_org_parent";
--> statement-breakpoint
ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS "fk_je_org_reversed";
--> statement-breakpoint
ALTER TABLE ledger_accounts DROP CONSTRAINT IF EXISTS "fk_ledger_accounts_org_parent";
