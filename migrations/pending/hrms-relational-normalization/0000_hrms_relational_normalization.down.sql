SET statement_timeout = 0;
SET lock_timeout = '5s';

DO $rollback_guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'hr_employee_sensitive_fields'
      AND column_name = 'disciplinary_records'
  ) OR NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'hr_employee_sensitive_fields'
      AND column_name = 'grievance_records'
  ) OR NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'documents'
      AND column_name = 'tags'
  ) OR NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'onboarding_tasks'
      AND column_name = 'depends_on_task_ids'
  ) OR NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'terminations'
      AND column_name = 'reasons'
  ) OR NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'terminations'
      AND column_name = 'supporting_doc_urls'
  ) THEN
    RAISE EXCEPTION 'HR_RELATIONAL_NORMALIZATION_LEGACY_CONTRACT_MISSING';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM hr_employee_sensitive_fields sensitive_fields
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(
        normalized_record.record_payload
        ORDER BY normalized_record.source_ordinal
      ) AS record_payloads
      FROM hr_employee_sensitive_disciplinary_records normalized_record
      WHERE normalized_record.organization_id = sensitive_fields.org_id
        AND normalized_record.sensitive_fields_id = sensitive_fields.id
    ) normalized_records ON true
    WHERE coalesce(sensitive_fields.disciplinary_records, '[]'::jsonb)
      IS DISTINCT FROM coalesce(normalized_records.record_payloads, '[]'::jsonb)
  ) OR EXISTS (
    SELECT 1
    FROM hr_employee_sensitive_fields sensitive_fields
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(
        normalized_record.record_payload
        ORDER BY normalized_record.source_ordinal
      ) AS record_payloads
      FROM hr_employee_sensitive_grievance_records normalized_record
      WHERE normalized_record.organization_id = sensitive_fields.org_id
        AND normalized_record.sensitive_fields_id = sensitive_fields.id
    ) normalized_records ON true
    WHERE coalesce(sensitive_fields.grievance_records, '[]'::jsonb)
      IS DISTINCT FROM coalesce(normalized_records.record_payloads, '[]'::jsonb)
  ) OR EXISTS (
    SELECT 1
    FROM documents document
    LEFT JOIN LATERAL (
      SELECT array_agg(normalized_tag.tag ORDER BY normalized_tag.sort_order) AS tags
      FROM hr_document_tags normalized_tag
      WHERE normalized_tag.organization_id = document.org_id
        AND normalized_tag.document_id = document.id
    ) normalized_tags ON true
    WHERE coalesce(document.tags, ARRAY[]::text[])
      IS DISTINCT FROM coalesce(normalized_tags.tags, ARRAY[]::text[])
  ) OR EXISTS (
    SELECT 1
    FROM onboarding_tasks onboarding_task
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(
        to_jsonb(normalized_dependency.prerequisite_task_id)
        ORDER BY normalized_dependency.sort_order
      ) AS dependency_task_ids
      FROM onboarding_task_dependencies normalized_dependency
      WHERE normalized_dependency.organization_id = onboarding_task.org_id
        AND normalized_dependency.onboarding_task_id = onboarding_task.id
    ) normalized_dependencies ON true
    WHERE coalesce(onboarding_task.depends_on_task_ids, '[]'::jsonb)
      IS DISTINCT FROM coalesce(normalized_dependencies.dependency_task_ids, '[]'::jsonb)
  ) OR EXISTS (
    SELECT 1
    FROM terminations termination
    LEFT JOIN LATERAL (
      SELECT array_agg(
        normalized_reason.reason
        ORDER BY normalized_reason.sort_order
      ) AS reasons
      FROM termination_reasons normalized_reason
      WHERE normalized_reason.organization_id = termination.org_id
        AND normalized_reason.termination_id = termination.id
    ) normalized_reasons ON true
    WHERE coalesce(termination.reasons, ARRAY[]::text[])
      IS DISTINCT FROM coalesce(normalized_reasons.reasons, ARRAY[]::text[])
  ) OR EXISTS (
    SELECT 1
    FROM terminations termination
    LEFT JOIN LATERAL (
      SELECT array_agg(
        normalized_document.legacy_url
        ORDER BY normalized_document.sort_order
      ) AS legacy_urls
      FROM termination_supporting_documents normalized_document
      WHERE normalized_document.organization_id = termination.org_id
        AND normalized_document.termination_id = termination.id
    ) normalized_documents ON true
    WHERE coalesce(termination.supporting_doc_urls, ARRAY[]::text[])
      IS DISTINCT FROM coalesce(normalized_documents.legacy_urls, ARRAY[]::text[])
  ) THEN
    RAISE EXCEPTION 'HR_RELATIONAL_NORMALIZATION_ROLLBACK_DRIFT';
  END IF;
END
$rollback_guard$;

DROP TABLE termination_supporting_documents;
DROP TABLE termination_reasons;
DROP TABLE onboarding_task_dependencies;
DROP TABLE hr_document_tags;
DROP TABLE hr_employee_sensitive_grievance_records;
DROP TABLE hr_employee_sensitive_disciplinary_records;
