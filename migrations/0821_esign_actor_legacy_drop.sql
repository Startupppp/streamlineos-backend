-- 0821_esign_actor_legacy_drop
-- Drop the seven legacy users.id actor columns from the e-sign schema now that:
--   • every companion *_membership_id column exists and its FK is validated (0815)
--   • all service write paths emit the companion column
--   • all service read paths join through the companion column
--
-- Columns dropped:
--   sign_bulk_send_jobs   sender_user_id
--   sign_documents        created_by
--   sign_envelopes        sender_user_id, voided_by
--   sign_public_forms     created_by
--   sign_recipients       user_id
--   sign_templates        owner_user_id

SET lock_timeout = '5s';
--> statement-breakpoint

-- Pre-flight: companion FKs must be validated
DO $$
DECLARE
  unvalidated text;
BEGIN
  SELECT string_agg(conname, ', ') INTO unvalidated
  FROM pg_constraint
  WHERE conname IN (
    'fk_sign_bulk_org_sender_mbr',
    'fk_sign_doc_org_created_mbr',
    'fk_sign_env_org_sender_mbr',
    'fk_sign_env_org_voided_mbr',
    'fk_sign_pf_org_created_mbr',
    'fk_sign_rcpt_org_user_mbr',
    'fk_sign_tpl_org_owner_mbr'
  )
    AND contype = 'f'
    AND NOT convalidated;

  IF unvalidated IS NOT NULL THEN
    RAISE EXCEPTION '0821: companion FKs not yet validated — run 0815 first: %', unvalidated;
  END IF;
END $$;
--> statement-breakpoint

-- sign_bulk_send_jobs: drop legacy sender FK then column
ALTER TABLE sign_bulk_send_jobs DROP CONSTRAINT IF EXISTS sign_bulk_send_jobs_sender_user_id_fkey;
--> statement-breakpoint
ALTER TABLE sign_bulk_send_jobs DROP COLUMN IF EXISTS sender_user_id;
--> statement-breakpoint

-- sign_documents: drop legacy creator FK then column
ALTER TABLE sign_documents DROP CONSTRAINT IF EXISTS sign_documents_created_by_fkey;
--> statement-breakpoint
ALTER TABLE sign_documents DROP COLUMN IF EXISTS created_by;
--> statement-breakpoint

-- sign_envelopes: drop legacy sender FK then column
ALTER TABLE sign_envelopes DROP CONSTRAINT IF EXISTS sign_envelopes_sender_user_id_fkey;
--> statement-breakpoint
ALTER TABLE sign_envelopes DROP COLUMN IF EXISTS sender_user_id;
--> statement-breakpoint

-- sign_envelopes: drop legacy voided_by FK then column
ALTER TABLE sign_envelopes DROP CONSTRAINT IF EXISTS sign_envelopes_voided_by_fkey;
--> statement-breakpoint
ALTER TABLE sign_envelopes DROP COLUMN IF EXISTS voided_by;
--> statement-breakpoint

-- sign_public_forms: drop legacy creator FK then column
ALTER TABLE sign_public_forms DROP CONSTRAINT IF EXISTS sign_public_forms_created_by_fkey;
--> statement-breakpoint
ALTER TABLE sign_public_forms DROP COLUMN IF EXISTS created_by;
--> statement-breakpoint

-- sign_recipients: drop legacy user FK then column
ALTER TABLE sign_recipients DROP CONSTRAINT IF EXISTS sign_recipients_user_id_fkey;
--> statement-breakpoint
ALTER TABLE sign_recipients DROP COLUMN IF EXISTS user_id;
--> statement-breakpoint

-- sign_templates: drop legacy owner FK then column
ALTER TABLE sign_templates DROP CONSTRAINT IF EXISTS sign_templates_owner_user_id_fkey;
--> statement-breakpoint
ALTER TABLE sign_templates DROP COLUMN IF EXISTS owner_user_id;
--> statement-breakpoint

-- Post-flight: confirm legacy columns are gone and companions are present
DO $$
DECLARE
  still_present text;
  companion_missing text;
BEGIN
  SELECT string_agg(format('%s.%s', tbl, col), ', ') INTO still_present
  FROM (VALUES
    ('sign_bulk_send_jobs', 'sender_user_id'),
    ('sign_documents', 'created_by'),
    ('sign_envelopes', 'sender_user_id'),
    ('sign_envelopes', 'voided_by'),
    ('sign_public_forms', 'created_by'),
    ('sign_recipients', 'user_id'),
    ('sign_templates', 'owner_user_id')
  ) AS t(tbl, col)
  WHERE EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_name = t.tbl AND c.column_name = t.col
  );

  IF still_present IS NOT NULL THEN
    RAISE EXCEPTION '0821: legacy columns still present after drop: %', still_present;
  END IF;

  SELECT string_agg(format('%s.%s', tbl, col), ', ') INTO companion_missing
  FROM (VALUES
    ('sign_bulk_send_jobs', 'sender_membership_id'),
    ('sign_documents', 'created_by_membership_id'),
    ('sign_envelopes', 'sender_membership_id'),
    ('sign_envelopes', 'voided_by_membership_id'),
    ('sign_public_forms', 'created_by_membership_id'),
    ('sign_recipients', 'user_membership_id'),
    ('sign_templates', 'owner_membership_id')
  ) AS t(tbl, col)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_name = t.tbl AND c.column_name = t.col
  );

  IF companion_missing IS NOT NULL THEN
    RAISE EXCEPTION '0821: companion columns missing: %', companion_missing;
  END IF;
END $$;
