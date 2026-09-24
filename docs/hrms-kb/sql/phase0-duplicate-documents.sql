-- HRMS-KB Phase 0 — read-only duplicate census for the D12 identity key.
--
-- Identity key (D12):  (org_id, user_id or NULL, category, name_normalized)
--   name_normalized = lower(btrim(regexp_replace(name, '\s+', ' ', 'g')))
--   NULL user_id  = a company document; NULL category is its own bucket (coalesced to '').
--
-- Safe to run against any environment: SELECT only, aggregates only (no names, no file keys).
-- Run as the table owner so RLS does not hide other tenants:
--   PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=60000' psql "$URL" -X -f <this file>
--
-- Only rows with is_active = true are counted: a soft-deleted row never blocks the index once the
-- unique index is created as a PARTIAL index (WHERE is_active). The second query shows what the
-- index would have to tolerate if it were NOT partial.
\pset pager off

\echo '== 1. Active duplicate groups per tenant (blocks a unique index on the D12 key)'
WITH keyed AS (
  SELECT org_id,
         user_id,
         coalesce(category, '') AS category,
         lower(btrim(regexp_replace(name, '\s+', ' ', 'g'))) AS name_normalized
  FROM documents
  WHERE is_active
), groups AS (
  SELECT org_id, count(*) AS rows_in_group
  FROM keyed
  GROUP BY org_id, user_id, category, name_normalized
  HAVING count(*) > 1
)
SELECT left(org_id, 8) AS org_prefix,
       count(*)                     AS duplicate_groups,
       sum(rows_in_group)           AS rows_involved,
       sum(rows_in_group - 1)       AS surplus_rows
FROM groups
GROUP BY org_id
ORDER BY surplus_rows DESC;

\echo
\echo '== 2. Same census including soft-deleted rows (what a NON-partial index would face)'
WITH keyed AS (
  SELECT org_id, user_id, coalesce(category, '') AS category,
         lower(btrim(regexp_replace(name, '\s+', ' ', 'g'))) AS name_normalized
  FROM documents
), groups AS (
  SELECT org_id, count(*) AS rows_in_group
  FROM keyed GROUP BY org_id, user_id, category, name_normalized HAVING count(*) > 1
)
SELECT left(org_id, 8) AS org_prefix, count(*) AS duplicate_groups, sum(rows_in_group - 1) AS surplus_rows
FROM groups GROUP BY org_id ORDER BY surplus_rows DESC;

\echo
\echo '== 3. Tenant totals (denominator) and type mix, so the counts above have context'
SELECT left(org_id, 8) AS org_prefix,
       count(*) FILTER (WHERE is_active)                                  AS active_docs,
       count(*) FILTER (WHERE is_active AND user_id IS NULL)              AS company_docs,
       count(*) FILTER (WHERE is_active AND is_public)                    AS public_flagged,
       count(*) FILTER (WHERE is_active AND is_public
                        AND type IN ('CONTRACT','ID_PROOF','PAYSLIP','OFFER_LETTER','RESUME','CERTIFICATE')) AS public_but_personal_type
FROM documents
GROUP BY org_id
ORDER BY active_docs DESC;

\echo
\echo '== 4. tenant-ID integrity: rows whose org_id has no organization, or whose user is in another org'
SELECT count(*) FILTER (WHERE o.id IS NULL) AS orphan_org_rows,
       count(*) FILTER (WHERE d.user_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM organization_members m WHERE m.org_id = d.org_id AND m.user_id = d.user_id)) AS user_not_member_of_doc_org
FROM documents d
LEFT JOIN organizations o ON o.id = d.org_id;

\echo
\echo '== 5. How were the rows produced? (fileUrl shape) — external URLs are metadata-only under D7'
SELECT left(org_id, 8) AS org_prefix,
       count(*) FILTER (WHERE file_url ~* '^https?://') AS external_url_rows,
       count(*) FILTER (WHERE file_url = '')            AS no_file_rows,
       count(*) FILTER (WHERE file_url !~* '^https?://' AND file_url <> '') AS storage_key_rows
FROM documents WHERE is_active GROUP BY org_id ORDER BY 1;
