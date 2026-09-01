-- Repair: drop the tenant_isolation policy on feedback_cycle_responses so that
-- 0678_rls_fix_feedback_cycle_responses can create it correctly on a cold replay.
--
-- Root cause: 0320_recon_phase_a_orgid (array position 39, when=1784993499561) is a
-- dynamic DO-block migration that adds org_id to every public table that lacks it but
-- has a NOT-NULL FK to an org-bearing parent. feedback_cycle_responses qualifies:
-- it has a NOT-NULL FK to feedback_cycle_requests, which has org_id. 0320 therefore
-- adds org_id, sets NOT NULL, and adds FK + UNIQUE constraints on it.
--
-- Then 0378_rls_remaining_tenant_tables (array position 103, when=1784993516607) runs
-- its dynamic pg_catalog sweep and creates tenant_isolation on feedback_cycle_responses
-- because it now carries org_id and has no RLS.
--
-- When 0678_rls_fix_feedback_cycle_responses (array position 395, when=1788091265000)
-- reaches its final statement (CREATE POLICY tenant_isolation), the policy already
-- exists from 0378 and the transaction fails 42P16.
--
-- This file is placed between 0677 (idx=393) and 0678 (idx=394) in the journal array
-- so the cold replay drops the policy before 0678 runs. 0678 then creates the policy
-- correctly and all its FK / index work also commits in the same transaction.
--
-- PRODUCTION / WATERMARK INTERACTION:
--   This file's when (1798000159000) is above the production watermark (1798000155000),
--   so production applies it as a pending migration in when order — after 0678's when
--   (1788091265000). Since 0678 also fails in production for the same reason (0378 ran
--   first), the policy still exists from 0378 when this migration runs. This migration
--   drops it. The companion 0678b_feedback_cycle_responses_rls_complete (when=1798000160000)
--   then recreates the policy and adds the index that 0678 never committed.
--
--   Do NOT lower when below the watermark: such an entry is skipped by db:migrate
--   while still printing success, stranding schema work permanently.
--
-- Mirrors 0591b, 0649b, 0676b exactly in class and rationale.

SET statement_timeout = 0;
SET lock_timeout = '5s';

--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON feedback_cycle_responses;
