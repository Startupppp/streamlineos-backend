-- HRMS-KB PR 1 — read-only report: KB attachments whose storage key points into a sensitive folder.
--
-- Before PR 1, POST /support/kb/articles/:id/attachments accepted any well-formed key inside the caller's
-- own organisation, and the KB indexer read that key with getFileStream (no sensitive-folder check),
-- extracted the text and embedded it. PR 1 refuses such keys on the way in and refuses to index them.
-- It deliberately DELETES NOTHING that already exists. This report is how you find out whether anything
-- already does; removing rows or chunks is a separate step for you to approve.
--
-- SELECT only, aggregate counts plus opaque ids. It prints no file names and no storage keys (the key
-- embeds the sanitised file name, which can itself be personal data). Run as the table owner so RLS
-- does not hide other tenants:
--   PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=60000' psql "$URL" -X -f <this file>
--
-- The folder root sits in segment 1 (`<folder>/…`, legacy), 2 (`<orgId>/<folder>/…`) or 3
-- (`<regionPrefix>/<orgId>/<folder>/…`); see parseStorageKey in src/modules/storage/storage-key.ts.
-- Matching any of the three over-approximates slightly: treat a hit as "look at this", not "leaked".
\pset pager off

WITH sensitive(root) AS (
  VALUES ('payroll'), ('payroll-exports'), ('payslips'), ('hr'), ('hr-documents'), ('hr-exports'),
         ('documents'), ('onboarding'), ('onboarding-docs'), ('resignations'), ('candidates'),
         ('candidate-vault'), ('esign'), ('e-sign'), ('signos'), ('signatures'), ('bank-batches'),
         ('gdpr-exports'), ('expense-exports'), ('fin-report-exports')
), flagged AS (
  SELECT a.id, a.org_id, a.page_id, a.deleted_at
  FROM kb_page_attachments a
  WHERE lower(split_part(a.file_key, '/', 1)) IN (SELECT root FROM sensitive)
     OR lower(split_part(a.file_key, '/', 2)) IN (SELECT root FROM sensitive)
     OR lower(split_part(a.file_key, '/', 3)) IN (SELECT root FROM sensitive)
)
SELECT '1. attachments pointing into a sensitive folder' AS check_name,
       left(f.org_id, 8) AS org_prefix,
       count(*)                                         AS attachments,
       count(*) FILTER (WHERE f.deleted_at IS NULL)     AS still_live,
       count(DISTINCT f.page_id)                        AS distinct_pages
FROM flagged f
GROUP BY f.org_id
ORDER BY attachments DESC;

\echo
\echo '== 2. Chunks derived from those attachments (these hold extracted text and an embedding)'
WITH sensitive(root) AS (
  VALUES ('payroll'), ('payroll-exports'), ('payslips'), ('hr'), ('hr-documents'), ('hr-exports'),
         ('documents'), ('onboarding'), ('onboarding-docs'), ('resignations'), ('candidates'),
         ('candidate-vault'), ('esign'), ('e-sign'), ('signos'), ('signatures'), ('bank-batches'),
         ('gdpr-exports'), ('expense-exports'), ('fin-report-exports')
)
SELECT left(c.org_id, 8) AS org_prefix,
       count(*)                       AS chunks,
       count(DISTINCT c.attachment_id) AS attachments
FROM kb_article_chunks c
JOIN kb_page_attachments a ON a.id = c.attachment_id AND a.org_id = c.org_id
WHERE lower(split_part(a.file_key, '/', 1)) IN (SELECT root FROM sensitive)
   OR lower(split_part(a.file_key, '/', 2)) IN (SELECT root FROM sensitive)
   OR lower(split_part(a.file_key, '/', 3)) IN (SELECT root FROM sensitive)
GROUP BY c.org_id
ORDER BY chunks DESC;

\echo
\echo '== 3. Same key registered as an HR document AND a KB attachment (a direct overlap, no folder guessing)'
SELECT left(a.org_id, 8) AS org_prefix, count(*) AS overlapping_rows
FROM kb_page_attachments a
JOIN documents d ON d.org_id = a.org_id AND d.file_url = a.file_key
GROUP BY a.org_id
ORDER BY overlapping_rows DESC;
