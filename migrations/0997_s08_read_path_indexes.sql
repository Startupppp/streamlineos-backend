-- Eight indexes for reads that exist today and have no index able to serve them.
-- Seven come from ticket 06's lifecycle-predicate corrections, one from ticket 19's
-- RBAC audit. Each was measured on this chain, not assumed: the fixtures and the
-- two EXPLAIN (ANALYZE, BUFFERS) pairs are recorded in report 08.
--
-- org_units is the one that matters. All six hierarchy list endpoints share the shape
-- WHERE org_id=$1 AND kind=$2 AND deleted_at IS NULL ORDER BY lower(name), id LIMIT n,
-- and idx_org_units_org_kind is neither partial nor able to supply that sort. Measured
-- as streamline_app with the tenant GUC over 50,000 units across 20 organisations:
--
--   before  Bitmap Index Scan + top-N heapsort of 568 rows   Buffers: shared hit=627
--   after   Index Scan, order supplied by the index          Buffers: shared hit=50 read=3
--
-- The buffer count is 11.8x, but the shape change is the durable part: with the sort
-- pushed into the index the LIMIT stops after 50 rows instead of reading every unit of
-- that kind in the organisation and sorting them.
--
-- role_permission_grants carries no index leading with permission_key and four live
-- reads filter on it, the members-with-permission resolver among them. Measured over
-- 60,000 grants across 20 organisations:
--
--   before  Bitmap Index Scan on uniq_role_permission_grants_role_key   index buffers 30
--   after   Bitmap Index Scan on idx_role_permission_grants_org_key     index buffers  2
--
-- Recorded honestly: this is 15x on the index side, not the sequential scan report 19
-- predicted. PostgreSQL 18 skip-scans the wide unique index, supplying an Index Cond on
-- (org_id, permission_key) while skipping role_id. On a server older than 18 there is no
-- skip scan and the same read degrades much further, so the index is worth having; the
-- claim that the composite is "unusable for a permission_key predicate" is not true here.
--
-- CREATE INDEX, not CREATE INDEX CONCURRENTLY. check-migration-discipline.mjs rejects
-- CONCURRENTLY outright because it cannot run inside drizzle-kit migrate's transaction
-- wrapper; lock_timeout is the sanctioned way to fail fast instead of queueing. Reports
-- 06 and 07 both specify CONCURRENTLY and are wrong about this repository.

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_org_units_org_kind_live
  ON org_units (org_id, kind, lower(name), id)
  WHERE deleted_at IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_org_units_org_kind_active
  ON org_units (org_id, kind)
  WHERE deleted_at IS NULL AND status <> 'ARCHIVED';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_acc_tax_payments_org_live_id
  ON acc_tax_payments (org_id, id DESC)
  WHERE archived_at IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_acc_tax_payments_org_live_created
  ON acc_tax_payments (org_id, created_at DESC)
  WHERE archived_at IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_organization_people_live_lookup
  ON organization_people (organization_id, organization_person_id)
  WHERE deleted_at IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_worker_engagements_org_worker_live
  ON worker_engagements (organization_id, worker_id)
  WHERE archived_at IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_hr_wf_def_lineage_live
  ON hr_workflow_definitions (org_id, object_type, name, version DESC)
  WHERE deleted_at IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_role_permission_grants_org_key
  ON role_permission_grants (org_id, permission_key);
