-- Wave 1 final lock-in: owner pointer NOT NULL.
-- Safe now: all existing orgs have owner_membership_id (bootstrap), createOrganization
-- preallocates the membership id and inserts the org WITH owner_membership_id (verified by
-- test-create-org-pattern.mjs + backend typecheck). Idempotent (SET NOT NULL is a no-op if already set).
ALTER TABLE organizations ALTER COLUMN owner_membership_id SET NOT NULL;
