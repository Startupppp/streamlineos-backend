-- GDPR rectification requests are workflow records, not implicit data mutations.
-- A correction remains pending/approved until the accountable domain owner applies
-- and audits the change; this prevents free-form requests from overwriting data.
ALTER TYPE "public"."hr_data_request_type" ADD VALUE IF NOT EXISTS 'correction';
