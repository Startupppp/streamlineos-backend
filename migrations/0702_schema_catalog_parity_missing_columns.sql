SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE calendar_source_preferences ADD COLUMN IF NOT EXISTS membership_id integer;
--> statement-breakpoint
ALTER TABLE chat_user_presence ADD COLUMN IF NOT EXISTS membership_id integer;
--> statement-breakpoint
ALTER TABLE fin_recurring_invoice_templates ADD COLUMN IF NOT EXISTS archived_at timestamp;
--> statement-breakpoint
ALTER TABLE kb_article_versions ADD COLUMN IF NOT EXISTS author_membership_id integer;
--> statement-breakpoint
ALTER TABLE kb_page_versions ADD COLUMN IF NOT EXISTS author_membership_id integer;
--> statement-breakpoint
ALTER TABLE expense_export_jobs ADD COLUMN IF NOT EXISTS requested_by_membership_id integer;
