SET lock_timeout = '5s';
--> statement-breakpoint

-- The employee self-service upload (POST /onboarding/documents) files a person's own document with them as both
-- owner and uploader, which is exactly the shape of an HR-filed company document, and lets them choose POLICY or
-- OTHER as the type. Migration 1201 therefore counted such a file as publishable. The one thing that tells them
-- apart is where the file is stored: that route, and only that route, writes under <org>/onboarding/. A document
-- there is the employee's own and is never publishable. Mirrors isEmployeeSelfUpload in
-- src/modules/hr/performance/documents-helpers.ts.
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
    AND position('/' || d.org_id || '/onboarding/' IN '/' || d.file_url) = 0
    AND NOT (coalesce(d.metadata, '{}'::jsonb) ?| ARRAY['candidateId', 'offerId']),
    false
  )
$$;
