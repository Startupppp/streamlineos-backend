SET statement_timeout = 0;
SET lock_timeout = '5s';

DO $verification$
DECLARE
  required_relation text;
  required_relations text[] := ARRAY[
    'hr_employee_sensitive_disciplinary_records',
    'hr_employee_sensitive_grievance_records',
    'hr_document_tags',
    'onboarding_task_dependencies',
    'termination_reasons',
    'termination_supporting_documents'
  ];
BEGIN
  FOREACH required_relation IN ARRAY required_relations LOOP
    IF to_regclass(format('public.%I', required_relation)) IS NULL THEN
      RAISE EXCEPTION 'HR_RELATIONAL_NORMALIZATION_RELATION_MISSING:%', required_relation;
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname = required_relation
        AND relation.relrowsecurity
    ) THEN
      RAISE EXCEPTION 'HR_RELATIONAL_NORMALIZATION_RLS_MISSING:%', required_relation;
    END IF;
    IF EXISTS (
      SELECT 1
      FROM pg_constraint constraint_record
      WHERE constraint_record.conrelid = format('public.%I', required_relation)::regclass
        AND constraint_record.contype = 'f'
        AND NOT constraint_record.convalidated
    ) THEN
      RAISE EXCEPTION 'HR_RELATIONAL_NORMALIZATION_FK_NOT_VALIDATED:%', required_relation;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM hr_employee_sensitive_fields sensitive_fields
    WHERE sensitive_fields.disciplinary_records IS NOT NULL
      AND jsonb_typeof(sensitive_fields.disciplinary_records) <> 'array'
  ) THEN
    RAISE EXCEPTION 'HR_RELATIONAL_NORMALIZATION_DISCIPLINARY_SOURCE_NOT_ARRAY';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM hr_employee_sensitive_fields sensitive_fields
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(sensitive_fields.disciplinary_records) = 'array'
        THEN sensitive_fields.disciplinary_records
        ELSE '[]'::jsonb
      END
    ) disciplinary_record
    WHERE jsonb_typeof(disciplinary_record) <> 'object'
  ) THEN
    RAISE EXCEPTION 'HR_RELATIONAL_NORMALIZATION_DISCIPLINARY_ENTRY_NOT_OBJECT';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM hr_employee_sensitive_fields sensitive_fields
    WHERE sensitive_fields.grievance_records IS NOT NULL
      AND jsonb_typeof(sensitive_fields.grievance_records) <> 'array'
  ) THEN
    RAISE EXCEPTION 'HR_RELATIONAL_NORMALIZATION_GRIEVANCE_SOURCE_NOT_ARRAY';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM hr_employee_sensitive_fields sensitive_fields
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(sensitive_fields.grievance_records) = 'array'
        THEN sensitive_fields.grievance_records
        ELSE '[]'::jsonb
      END
    ) grievance_record
    WHERE jsonb_typeof(grievance_record) <> 'object'
  ) THEN
    RAISE EXCEPTION 'HR_RELATIONAL_NORMALIZATION_GRIEVANCE_ENTRY_NOT_OBJECT';
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
  ) THEN
    RAISE EXCEPTION 'HR_RELATIONAL_NORMALIZATION_DISCIPLINARY_MISMATCH';
  END IF;
  IF EXISTS (
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
  ) THEN
    RAISE EXCEPTION 'HR_RELATIONAL_NORMALIZATION_GRIEVANCE_MISMATCH';
  END IF;
  IF EXISTS (
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
  ) THEN
    RAISE EXCEPTION 'HR_RELATIONAL_NORMALIZATION_DOCUMENT_TAG_MISMATCH';
  END IF;
  IF EXISTS (
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
  ) THEN
    RAISE EXCEPTION 'HR_RELATIONAL_NORMALIZATION_ONBOARDING_DEPENDENCY_MISMATCH';
  END IF;
  IF EXISTS (
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
  ) THEN
    RAISE EXCEPTION 'HR_RELATIONAL_NORMALIZATION_TERMINATION_REASON_MISMATCH';
  END IF;
  IF EXISTS (
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
    RAISE EXCEPTION 'HR_RELATIONAL_NORMALIZATION_SUPPORTING_DOCUMENT_MISMATCH';
  END IF;
END
$verification$;

SELECT
  (SELECT count(*) FROM hr_employee_sensitive_disciplinary_records)
    AS disciplinary_record_count,
  (SELECT count(*) FROM hr_employee_sensitive_grievance_records)
    AS grievance_record_count,
  (SELECT count(*) FROM hr_document_tags) AS document_tag_count,
  (SELECT count(*) FROM onboarding_task_dependencies)
    AS onboarding_task_dependency_count,
  (SELECT count(*) FROM termination_reasons) AS termination_reason_count,
  (SELECT count(*) FROM termination_supporting_documents)
    AS termination_supporting_document_count;
