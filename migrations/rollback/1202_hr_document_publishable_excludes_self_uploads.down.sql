-- Rollback for 1202_hr_document_publishable_excludes_self_uploads. Restores the 1201 definition, under which a
-- document an employee uploaded for themselves through onboarding and typed POLICY or OTHER counts as
-- publishable. Roll it back only together with the feature.
SET lock_timeout = '5s';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.hr_document_is_publishable(d public.documents)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT coalesce(
    d.is_active
    AND d.classification IN ('INTERNAL', 'RESTRICTED')
    AND d.type IN ('POLICY', 'OTHER')
    AND (d.user_id IS NULL OR d.user_id = d.uploaded_by)
    AND NOT (coalesce(d.metadata, '{}'::jsonb) ?| ARRAY['candidateId', 'offerId']),
    false
  )
$$;
