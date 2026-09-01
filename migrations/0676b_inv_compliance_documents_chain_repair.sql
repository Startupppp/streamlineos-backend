-- inv_compliance_documents missing from the chain at the points 0677 and 0666 run.
--
-- Root cause: inv_compliance_documents was created on the live database via
-- `drizzle-kit push` and never had a corresponding CREATE TABLE migration at the
-- correct journal position. The first migration to CREATE this table is
-- 0669_chain_creates_inv_compliance_documents (journal idx=410), but 0677_rls_fix_guc_key
-- (idx=391) and 0666_rls_missing_tables (idx=408) both reference the table before it is
-- created in array order. On a cold replay, when 0677 runs and attempts
-- `CREATE POLICY tenant_isolation ON inv_compliance_documents`, the table does not yet
-- exist and the statement fails with 42P01.
--
-- This file is the structural fix. It is placed between 0676 (idx=390) and 0677
-- (idx=391) in the journal so a cold bootstrap creates the table before 0677 and 0666
-- run. Every statement is idempotent (CREATE TABLE IF NOT EXISTS), so this file is a
-- complete no-op against any database that already holds this table — including the live
-- production database.
--
-- RLS, policies, grants, foreign keys and indexes for inv_compliance_documents remain in
-- 0666 (RLS + policy) and 0669 (FK constraints, indexes). This file creates only the
-- bare table structure so the policy-creation statements in 0677 and 0666 can reference
-- it. In PostgreSQL, CREATE POLICY on a table with RLS disabled is valid; the policy
-- is stored but dormant until ENABLE ROW LEVEL SECURITY fires.
--
-- WATERMARK INTERACTION (read this before changing the `when` value):
--   apply-chain-cold.mjs processes journal entries in JSON ARRAY ORDER, not by `when`.
--   This file is positioned between idx=390 (0676) and idx=391 (0677) in the array, so
--   a cold bootstrap runs it before 0677 regardless of `when`. Drizzle-kit on PRODUCTION
--   uses `when` to determine what to apply: it skips any journal entry whose
--   `when` <= max applied `when`. This file's `when` (1798000158000) is above the
--   production watermark at the time it was authored, so production will apply it as a
--   normal pending migration. All statements are idempotent (IF NOT EXISTS), so the
--   apply is a no-op and is safe.
--
--   Do NOT lower `when` below the production watermark: a journal entry below the
--   watermark that is not in the applied set is flagged as SKIPPED by
--   check-migration-ledger.mjs and will never apply.
--
-- Mirrors 0591b, 0649b, and 0767b exactly in pattern and rationale.

SET statement_timeout = 0;
SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."inv_compliance_documents" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL,
  "kind" text NOT NULL,
  "source_type" text NOT NULL,
  "source_id" text NOT NULL,
  "document_number" text NOT NULL,
  "payload_hash" text NOT NULL,
  "adapter_code" text NOT NULL,
  "adapter_is_live" boolean NOT NULL DEFAULT false,
  "status" text NOT NULL,
  "external_id" text,
  "acknowledged_at" timestamp without time zone,
  "error_code" text,
  "error_message" text,
  "attempts" integer NOT NULL DEFAULT 0,
  "raw_response" jsonb,
  "created_by" text,
  "created_at" timestamp without time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp without time zone NOT NULL DEFAULT now()
);
