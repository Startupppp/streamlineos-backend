-- Rollback for migration 1111.
--
-- The forward migration granted SELECT/INSERT/UPDATE/DELETE on 20 named tables,
-- granted USAGE/SELECT on every public sequence that lacked USAGE for streamline_app,
-- and set ALTER DEFAULT PRIVILEGES so future tables and sequences are covered.
--
-- What this rollback cannot fully restore:
--   * Sequence privileges: the forward migration only added USAGE/SELECT to sequences
--     that did not already have it, but did not record which those were. This rollback
--     omits sequence revocation to avoid stripping privileges that pre-existed migration
--     1111. An operator who needs to revert sequence privileges must inspect
--     pg_default_acl and sequence ACLs manually.
--   * DEFAULT PRIVILEGES role scope: the forward used current_user at migration time.
--     This rollback does the same. If the owning role differs from the session running
--     the rollback, the operator must repeat the REVOKE using the correct role identity.
--
-- Dependency order: per-table revocations first (each conditional on the table existing),
-- then default privileges revocation.

SET lock_timeout = '5s';
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.calendar_provider_sync_queue') IS NOT NULL THEN
    EXECUTE 'REVOKE SELECT, INSERT, UPDATE, DELETE ON "calendar_provider_sync_queue" FROM streamline_app';
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.chat_message_reactions') IS NOT NULL THEN
    EXECUTE 'REVOKE SELECT, INSERT, UPDATE, DELETE ON "chat_message_reactions" FROM streamline_app';
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.communication_backfill_issues') IS NOT NULL THEN
    EXECUTE 'REVOKE SELECT, INSERT, UPDATE, DELETE ON "communication_backfill_issues" FROM streamline_app';
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.expense_export_jobs') IS NOT NULL THEN
    EXECUTE 'REVOKE SELECT, INSERT, UPDATE, DELETE ON "expense_export_jobs" FROM streamline_app';
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.file_quarantine_records') IS NOT NULL THEN
    EXECUTE 'REVOKE SELECT, INSERT, UPDATE, DELETE ON "file_quarantine_records" FROM streamline_app';
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.fin_expense_policies') IS NOT NULL THEN
    EXECUTE 'REVOKE SELECT, INSERT, UPDATE, DELETE ON "fin_expense_policies" FROM streamline_app';
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.fin_reimbursement_batches') IS NOT NULL THEN
    EXECUTE 'REVOKE SELECT, INSERT, UPDATE, DELETE ON "fin_reimbursement_batches" FROM streamline_app';
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.gdpr_export_jobs') IS NOT NULL THEN
    EXECUTE 'REVOKE SELECT, INSERT, UPDATE, DELETE ON "gdpr_export_jobs" FROM streamline_app';
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_carrier_operations') IS NOT NULL THEN
    EXECUTE 'REVOKE SELECT, INSERT, UPDATE, DELETE ON "inv_carrier_operations" FROM streamline_app';
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_carrier_webhook_deliveries') IS NOT NULL THEN
    EXECUTE 'REVOKE SELECT, INSERT, UPDATE, DELETE ON "inv_carrier_webhook_deliveries" FROM streamline_app';
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_channel_jobs') IS NOT NULL THEN
    EXECUTE 'REVOKE SELECT, INSERT, UPDATE, DELETE ON "inv_channel_jobs" FROM streamline_app';
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_ingestion_checkpoints') IS NOT NULL THEN
    EXECUTE 'REVOKE SELECT, INSERT, UPDATE, DELETE ON "kb_ingestion_checkpoints" FROM streamline_app';
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_page_attachments') IS NOT NULL THEN
    EXECUTE 'REVOKE SELECT, INSERT, UPDATE, DELETE ON "kb_page_attachments" FROM streamline_app';
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_tenant_backfill_issues') IS NOT NULL THEN
    EXECUTE 'REVOKE SELECT, INSERT, UPDATE, DELETE ON "kb_tenant_backfill_issues" FROM streamline_app';
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.mail_sync_checkpoints') IS NOT NULL THEN
    EXECUTE 'REVOKE SELECT, INSERT, UPDATE, DELETE ON "mail_sync_checkpoints" FROM streamline_app';
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.multipart_upload_intents') IS NOT NULL THEN
    EXECUTE 'REVOKE SELECT, INSERT, UPDATE, DELETE ON "multipart_upload_intents" FROM streamline_app';
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.operator_access_grants') IS NOT NULL THEN
    EXECUTE 'REVOKE SELECT, INSERT, UPDATE, DELETE ON "operator_access_grants" FROM streamline_app';
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.operator_access_log') IS NOT NULL THEN
    EXECUTE 'REVOKE SELECT, INSERT, UPDATE, DELETE ON "operator_access_log" FROM streamline_app';
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.payroll_run_export_jobs') IS NOT NULL THEN
    EXECUTE 'REVOKE SELECT, INSERT, UPDATE, DELETE ON "payroll_run_export_jobs" FROM streamline_app';
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.storage_pending_purge') IS NOT NULL THEN
    EXECUTE 'REVOKE SELECT, INSERT, UPDATE, DELETE ON "storage_pending_purge" FROM streamline_app';
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM streamline_app',
    current_user);
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE USAGE, SELECT ON SEQUENCES FROM streamline_app',
    current_user);
END $$;
