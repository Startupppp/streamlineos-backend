SET statement_timeout = 0;
SET lock_timeout = '5s';
SET TIME ZONE 'UTC';

INSERT INTO hr_employee_sensitive_disciplinary_records (
  organization_id,
  sensitive_fields_id,
  source_ordinal,
  record_payload,
  created_at,
  updated_at
)
SELECT
  sensitive_fields.org_id,
  sensitive_fields.id,
  disciplinary_record.source_ordinal - 1,
  disciplinary_record.record_payload,
  sensitive_fields.created_at,
  sensitive_fields.updated_at
FROM hr_employee_sensitive_fields sensitive_fields
CROSS JOIN LATERAL jsonb_array_elements(
  CASE
    WHEN jsonb_typeof(sensitive_fields.disciplinary_records) = 'array'
    THEN sensitive_fields.disciplinary_records
    ELSE '[]'::jsonb
  END
)
  WITH ORDINALITY AS disciplinary_record(record_payload, source_ordinal)
WHERE sensitive_fields.disciplinary_records IS NOT NULL
  AND jsonb_typeof(sensitive_fields.disciplinary_records) = 'array'
  AND jsonb_typeof(disciplinary_record.record_payload) = 'object'
ON CONFLICT (organization_id, sensitive_fields_id, source_ordinal) DO NOTHING;

INSERT INTO hr_employee_sensitive_grievance_records (
  organization_id,
  sensitive_fields_id,
  source_ordinal,
  record_payload,
  created_at,
  updated_at
)
SELECT
  sensitive_fields.org_id,
  sensitive_fields.id,
  grievance_record.source_ordinal - 1,
  grievance_record.record_payload,
  sensitive_fields.created_at,
  sensitive_fields.updated_at
FROM hr_employee_sensitive_fields sensitive_fields
CROSS JOIN LATERAL jsonb_array_elements(
  CASE
    WHEN jsonb_typeof(sensitive_fields.grievance_records) = 'array'
    THEN sensitive_fields.grievance_records
    ELSE '[]'::jsonb
  END
)
  WITH ORDINALITY AS grievance_record(record_payload, source_ordinal)
WHERE sensitive_fields.grievance_records IS NOT NULL
  AND jsonb_typeof(sensitive_fields.grievance_records) = 'array'
  AND jsonb_typeof(grievance_record.record_payload) = 'object'
ON CONFLICT (organization_id, sensitive_fields_id, source_ordinal) DO NOTHING;

WITH document_tag_candidates AS (
  SELECT
    document.org_id AS organization_id,
    document.id AS document_id,
    document_tag.tag,
    document_tag.sort_order - 1 AS sort_order,
    document.created_at,
    row_number() OVER (
      PARTITION BY document.org_id, document.id, document_tag.tag
      ORDER BY document_tag.sort_order
    ) AS duplicate_rank
  FROM documents document
  CROSS JOIN LATERAL unnest(document.tags)
    WITH ORDINALITY AS document_tag(tag, sort_order)
  WHERE document.tags IS NOT NULL
    AND cardinality(document.tags) > 0
    AND btrim(document_tag.tag) <> ''
)
INSERT INTO hr_document_tags (
  organization_id,
  document_id,
  tag,
  sort_order,
  created_at
)
SELECT
  organization_id,
  document_id,
  tag,
  sort_order,
  created_at
FROM document_tag_candidates
WHERE duplicate_rank = 1
ON CONFLICT DO NOTHING;

WITH dependency_elements AS (
  SELECT
    onboarding_task.org_id AS organization_id,
    onboarding_task.id AS onboarding_task_id,
    dependency_element.dependency_text,
    dependency_element.sort_order - 1 AS sort_order,
    onboarding_task.created_at,
    CASE
      WHEN dependency_element.dependency_text ~ '^[0-9]+$'
        AND length(dependency_element.dependency_text) <= 10
      THEN CASE
        WHEN dependency_element.dependency_text::numeric BETWEEN 1 AND 2147483647
        THEN dependency_element.dependency_text::integer
      END
    END AS prerequisite_task_id
  FROM onboarding_tasks onboarding_task
  CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE
      WHEN jsonb_typeof(onboarding_task.depends_on_task_ids) = 'array'
      THEN onboarding_task.depends_on_task_ids
      ELSE '[]'::jsonb
    END
  )
    WITH ORDINALITY AS dependency_element(dependency_text, sort_order)
  WHERE onboarding_task.depends_on_task_ids IS NOT NULL
    AND jsonb_typeof(onboarding_task.depends_on_task_ids) = 'array'
),
valid_dependencies AS (
  SELECT
    dependency_element.*,
    row_number() OVER (
      PARTITION BY
        dependency_element.organization_id,
        dependency_element.onboarding_task_id,
        dependency_element.prerequisite_task_id
      ORDER BY dependency_element.sort_order
    ) AS duplicate_rank
  FROM dependency_elements dependency_element
  INNER JOIN onboarding_tasks prerequisite_task
    ON prerequisite_task.org_id = dependency_element.organization_id
    AND prerequisite_task.id = dependency_element.prerequisite_task_id
  WHERE dependency_element.prerequisite_task_id IS NOT NULL
    AND dependency_element.onboarding_task_id <> dependency_element.prerequisite_task_id
)
INSERT INTO onboarding_task_dependencies (
  organization_id,
  onboarding_task_id,
  prerequisite_task_id,
  sort_order,
  created_at
)
SELECT
  organization_id,
  onboarding_task_id,
  prerequisite_task_id,
  sort_order,
  created_at
FROM valid_dependencies
WHERE duplicate_rank = 1
ON CONFLICT DO NOTHING;

WITH termination_reason_candidates AS (
  SELECT
    termination.org_id AS organization_id,
    termination.id AS termination_id,
    termination_reason.reason,
    termination_reason.sort_order - 1 AS sort_order,
    termination.created_at,
    row_number() OVER (
      PARTITION BY termination.org_id, termination.id, termination_reason.reason
      ORDER BY termination_reason.sort_order
    ) AS duplicate_rank
  FROM terminations termination
  CROSS JOIN LATERAL unnest(termination.reasons)
    WITH ORDINALITY AS termination_reason(reason, sort_order)
  WHERE termination.reasons IS NOT NULL
    AND cardinality(termination.reasons) > 0
    AND btrim(termination_reason.reason) <> ''
)
INSERT INTO termination_reasons (
  organization_id,
  termination_id,
  reason,
  sort_order,
  created_at
)
SELECT
  organization_id,
  termination_id,
  reason,
  sort_order,
  created_at
FROM termination_reason_candidates
WHERE duplicate_rank = 1
ON CONFLICT DO NOTHING;

WITH supporting_document_candidates AS (
  SELECT
    termination.org_id AS organization_id,
    termination.id AS termination_id,
    supporting_document.legacy_url,
    supporting_document.sort_order - 1 AS sort_order,
    termination.created_at,
    row_number() OVER (
      PARTITION BY
        termination.org_id,
        termination.id,
        supporting_document.legacy_url
      ORDER BY supporting_document.sort_order
    ) AS duplicate_rank
  FROM terminations termination
  CROSS JOIN LATERAL unnest(termination.supporting_doc_urls)
    WITH ORDINALITY AS supporting_document(legacy_url, sort_order)
  WHERE termination.supporting_doc_urls IS NOT NULL
    AND cardinality(termination.supporting_doc_urls) > 0
    AND btrim(supporting_document.legacy_url) <> ''
)
INSERT INTO termination_supporting_documents (
  organization_id,
  termination_id,
  legacy_url,
  sort_order,
  created_at
)
SELECT
  organization_id,
  termination_id,
  legacy_url,
  sort_order,
  created_at
FROM supporting_document_candidates
WHERE duplicate_rank = 1
ON CONFLICT DO NOTHING;
