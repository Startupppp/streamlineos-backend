SET lock_timeout = '5s';
--> statement-breakpoint
-- Grant the application role access to tables whose creating migrations omitted it.
--
-- On a database built by replaying the journal, these tables had NO privileges for
-- `streamline_app` at all. That breaks reads as well as writes: the chat message
-- timeline reads `chat_message_reactions`, so loading any channel raised 42501 and
-- `/chat` rendered an error boundary. `subscription_purchases` failed the same way on
-- `POST /billing/checkout` and was granted separately in `1090`.
--
-- Two things make this class expensive to diagnose, which is why the grants are made
-- explicit here rather than left to a blanket statement:
--   * 42501 reads as an RLS denial. These tables have RLS disabled and no policies, so
--     the usual first checks (policy present, tenant GUC set) all look correct.
--   * The sequence grant is separately load-bearing. Granting only the table fails
--     identically on the next insert ("permission denied for sequence ..._id_seq"), so
--     a partial fix looks like no fix.
--
-- `GRANT ... ON ALL TABLES IN SCHEMA` is deliberately NOT used: it is point-in-time and
-- would not cover tables created by any migration applied after it, which is exactly how
-- this gap arose. Each table is named, and each statement is guarded by `to_regclass` so
-- the migration is safe on a database where a given table does not exist.
--
-- The durable fix is ALTER DEFAULT PRIVILEGES for the owning role so new tables are
-- covered by construction; that is a deployment/ownership change and is not made here.

--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.calendar_provider_sync_queue') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "calendar_provider_sync_queue" TO streamline_app';
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.chat_message_reactions') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "chat_message_reactions" TO streamline_app';
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.communication_backfill_issues') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "communication_backfill_issues" TO streamline_app';
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.expense_export_jobs') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "expense_export_jobs" TO streamline_app';
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.file_quarantine_records') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "file_quarantine_records" TO streamline_app';
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.fin_expense_policies') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_expense_policies" TO streamline_app';
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.fin_reimbursement_batches') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_reimbursement_batches" TO streamline_app';
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.gdpr_export_jobs') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "gdpr_export_jobs" TO streamline_app';
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_carrier_operations') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "inv_carrier_operations" TO streamline_app';
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_carrier_webhook_deliveries') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "inv_carrier_webhook_deliveries" TO streamline_app';
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_channel_jobs') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "inv_channel_jobs" TO streamline_app';
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_ingestion_checkpoints') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "kb_ingestion_checkpoints" TO streamline_app';
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_page_attachments') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "kb_page_attachments" TO streamline_app';
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_tenant_backfill_issues') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "kb_tenant_backfill_issues" TO streamline_app';
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.mail_sync_checkpoints') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "mail_sync_checkpoints" TO streamline_app';
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.multipart_upload_intents') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "multipart_upload_intents" TO streamline_app';
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.operator_access_grants') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "operator_access_grants" TO streamline_app';
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.operator_access_log') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "operator_access_log" TO streamline_app';
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.payroll_run_export_jobs') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "payroll_run_export_jobs" TO streamline_app';
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.storage_pending_purge') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "storage_pending_purge" TO streamline_app';
  END IF;
END $$;
--> statement-breakpoint
DO $$
DECLARE seq record;
BEGIN
  FOR seq IN
    SELECT s.ident
      FROM (
        SELECT quote_ident(n.nspname) || '.' || quote_ident(c.relname) AS ident, c.oid
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind = 'S'
           AND n.nspname = 'public'
         OFFSET 0
      ) s
     WHERE NOT has_sequence_privilege('streamline_app', s.oid, 'USAGE')
  LOOP
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE ' || seq.ident || ' TO streamline_app';
  END LOOP;
END $$;

--> statement-breakpoint
DO $$ BEGIN
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO streamline_app',
    current_user);
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO streamline_app',
    current_user);
END $$;
