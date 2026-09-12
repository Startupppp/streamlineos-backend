-- Custom SQL migration file, put your code below! --

-- Admission: the half of the waitlist that lets anybody in.
--
-- Phase 3 ticket 13. `platform_waitlist` already carries `status` and
-- `invited_at`, so the schema anticipated admission from the start -- and
-- nothing has ever written either. The table collects entries and there is no
-- path out of it: every row is PENDING forever and no one can be let in.
--
-- This is deliberately NOT a reopening of self-serve signup, which was removed
-- on 25 August in favour of the waitlist. A token is minted only by somebody
-- with the permission to admit, is single-use, and expires -- so the front door
-- opens one named person at a time, which is what a waitlist is for.
--
-- The token is stored hashed, matching `invitations`. A database backup should
-- not contain live credentials for creating organisations, and the raw value
-- exists only in the email that carried it.

SET lock_timeout = '5s';

ALTER TABLE platform_waitlist
  ADD COLUMN IF NOT EXISTS token_hash text,
  ADD COLUMN IF NOT EXISTS token_expires_at timestamp,
  ADD COLUMN IF NOT EXISTS admitted_by_user_id text,
  ADD COLUMN IF NOT EXISTS admitted_at timestamp,
  ADD COLUMN IF NOT EXISTS claimed_at timestamp,
  ADD COLUMN IF NOT EXISTS claimed_org_id text;

-- Lookup is by hash on the claim path, which is unauthenticated and therefore
-- the one query here that must not be a sequential scan. Partial, because a
-- consumed or unminted row is never looked up this way and indexing them would
-- grow the index with rows it can never serve.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_platform_waitlist_token
  ON platform_waitlist (token_hash)
  WHERE token_hash IS NOT NULL;

-- Who was let in and when, for the operator surface. `admitted_at` rather than
-- reusing `invited_at`: the existing column is what the *notification* used, and
-- conflating "we told them" with "we let them in" makes the funnel unmeasurable
-- the first time a send fails.
CREATE INDEX IF NOT EXISTS idx_platform_waitlist_admitted
  ON platform_waitlist (admitted_at DESC NULLS LAST);

-- The organisation a claim produced. NOT VALID then VALIDATE, so the scan does
-- not hold a lock on `organizations` while the table is in use.
ALTER TABLE platform_waitlist
  ADD CONSTRAINT fk_platform_waitlist_claimed_org
  FOREIGN KEY (claimed_org_id) REFERENCES organizations (id) ON DELETE SET NULL
  NOT VALID;

ALTER TABLE platform_waitlist VALIDATE CONSTRAINT fk_platform_waitlist_claimed_org;
