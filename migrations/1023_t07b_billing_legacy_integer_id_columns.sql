-- Five columns whose live type has never matched their Drizzle declaration, and the
-- five foreign keys that could not exist because of it.
--
-- `referrals.referrer_org_id`, `referrals.referred_org_id`, `referrals.referrer_user_id`,
-- `affiliate_commissions.referred_org_id` and `app_installations.installed_by` were
-- created `integer` by migration 0000, back when organization and user ids were serial
-- integers. Both id columns became `text` and every other table followed; these five did
-- not. `src/db/schema/billing/billing.ts` has declared all five as
-- `text(...).references(() => organizations.id | users.id)` ever since, so Postgres could
-- never install the constraint -- an integer column cannot reference a text key. That is
-- why they appear as "a declared .references() with no live constraint": the constraint is
-- missing, not redundant, and the cause is the column type.
--
-- The drift is not cosmetic. `ReferralService.createReferral(referrerOrgId: string, ...)`
-- and `AffiliateService` both insert an organization id into these columns, and the write
-- fails at run time:
--
--   INSERT INTO referrals (referrer_org_id, ...) VALUES ('org_...', ...)
--     -> ERROR: invalid input syntax for type integer: "org_..."   (22P02)
--
-- reproduced on a scratch database at head before this migration was written. All three
-- tables hold 0 rows on the production-shaped seed, which is what a write path that has
-- never succeeded looks like.
--
-- No row is deleted or rewritten here. If any database does hold a row whose id cannot be
-- resolved after the cast, this migration RAISEs and names the table and the count, so a
-- human decides -- a migration must not quietly delete a customer's rows to make its own
-- constraint validate.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE referrals ALTER COLUMN referrer_org_id TYPE text USING referrer_org_id::text;
--> statement-breakpoint

ALTER TABLE referrals ALTER COLUMN referred_org_id TYPE text USING referred_org_id::text;
--> statement-breakpoint

ALTER TABLE referrals ALTER COLUMN referrer_user_id TYPE text USING referrer_user_id::text;
--> statement-breakpoint

ALTER TABLE affiliate_commissions ALTER COLUMN referred_org_id TYPE text USING referred_org_id::text;
--> statement-breakpoint

ALTER TABLE app_installations ALTER COLUMN installed_by TYPE text USING installed_by::text;
--> statement-breakpoint

DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM referrals r
    WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = r.referrer_org_id);
  IF n > 0 THEN
    RAISE EXCEPTION
      'referrals: % row(s) whose referrer_org_id does not resolve to an organization. Resolve or remove them, then re-run.', n;
  END IF;

  SELECT count(*) INTO n FROM referrals r
    WHERE r.referred_org_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = r.referred_org_id);
  IF n > 0 THEN
    RAISE EXCEPTION
      'referrals: % row(s) whose referred_org_id does not resolve to an organization. Set them NULL, then re-run.', n;
  END IF;

  SELECT count(*) INTO n FROM referrals r
    WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = r.referrer_user_id);
  IF n > 0 THEN
    RAISE EXCEPTION
      'referrals: % row(s) whose referrer_user_id does not resolve to a user. Resolve or remove them, then re-run.', n;
  END IF;

  SELECT count(*) INTO n FROM affiliate_commissions a
    WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = a.referred_org_id);
  IF n > 0 THEN
    RAISE EXCEPTION
      'affiliate_commissions: % row(s) whose referred_org_id does not resolve to an organization. Resolve or remove them, then re-run.', n;
  END IF;

  SELECT count(*) INTO n FROM app_installations i
    WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = i.installed_by);
  IF n > 0 THEN
    RAISE EXCEPTION
      'app_installations: % row(s) whose installed_by does not resolve to a user. Resolve them, then re-run.', n;
  END IF;
END
$$;
--> statement-breakpoint

ALTER TABLE referrals
  ADD CONSTRAINT fk_referrals_referrer_org
  FOREIGN KEY (referrer_org_id) REFERENCES organizations (id) ON DELETE CASCADE NOT VALID;
--> statement-breakpoint

ALTER TABLE referrals
  ADD CONSTRAINT fk_referrals_referred_org
  FOREIGN KEY (referred_org_id) REFERENCES organizations (id) ON DELETE CASCADE NOT VALID;
--> statement-breakpoint

ALTER TABLE referrals
  ADD CONSTRAINT fk_referrals_referrer_user
  FOREIGN KEY (referrer_user_id) REFERENCES users (id) ON DELETE CASCADE NOT VALID;
--> statement-breakpoint

ALTER TABLE affiliate_commissions
  ADD CONSTRAINT fk_affiliate_commissions_referred_org
  FOREIGN KEY (referred_org_id) REFERENCES organizations (id) ON DELETE CASCADE NOT VALID;
--> statement-breakpoint

ALTER TABLE app_installations
  ADD CONSTRAINT fk_app_installations_installed_by
  FOREIGN KEY (installed_by) REFERENCES users (id) ON DELETE CASCADE NOT VALID;
--> statement-breakpoint

ALTER TABLE referrals VALIDATE CONSTRAINT fk_referrals_referrer_org;
--> statement-breakpoint

ALTER TABLE referrals VALIDATE CONSTRAINT fk_referrals_referred_org;
--> statement-breakpoint

ALTER TABLE referrals VALIDATE CONSTRAINT fk_referrals_referrer_user;
--> statement-breakpoint

ALTER TABLE affiliate_commissions VALIDATE CONSTRAINT fk_affiliate_commissions_referred_org;
--> statement-breakpoint

ALTER TABLE app_installations VALIDATE CONSTRAINT fk_app_installations_installed_by;
--> statement-breakpoint

-- Every foreign key needs an index on the child side or the parent delete degrades to a
-- sequential scan per row. `referrals.referrer_org_id` already has `referrals_referrer_idx`.
-- Not CONCURRENTLY: db:migrate runs inside a transaction.
CREATE INDEX IF NOT EXISTS idx_referrals_referred_org
  ON referrals (referred_org_id) WHERE referred_org_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_referrals_referrer_user ON referrals (referrer_user_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_affiliate_commissions_referred_org
  ON affiliate_commissions (referred_org_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_app_installations_installed_by
  ON app_installations (installed_by);
--> statement-breakpoint

DO $$
DECLARE
  wrong_type text;
  missing text;
BEGIN
  SELECT string_agg(c.relname || '.' || a.attname, ', ') INTO wrong_type
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  WHERE (c.relname, a.attname) IN (
          ('referrals', 'referrer_org_id'), ('referrals', 'referred_org_id'),
          ('referrals', 'referrer_user_id'), ('affiliate_commissions', 'referred_org_id'),
          ('app_installations', 'installed_by'))
    AND format_type(a.atttypid, a.atttypmod) <> 'text';
  IF wrong_type IS NOT NULL THEN
    RAISE EXCEPTION '1023 did not convert: %', wrong_type;
  END IF;

  SELECT string_agg(want.name, ', ') INTO missing
  FROM (VALUES
    ('fk_referrals_referrer_org'), ('fk_referrals_referred_org'),
    ('fk_referrals_referrer_user'), ('fk_affiliate_commissions_referred_org'),
    ('fk_app_installations_installed_by')) AS want(name)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    WHERE con.conname = want.name AND con.contype = 'f' AND con.convalidated);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '1023 left a foreign key missing or unvalidated: %', missing;
  END IF;

  -- `CREATE INDEX IF NOT EXISTS` is a no-op against a name already in use, whatever that
  -- index covers, so the name alone proves nothing. Assert the leading column.
  SELECT string_agg(want.name, ', ') INTO missing
  FROM (VALUES
    ('idx_referrals_referred_org', 'referred_org_id'),
    ('idx_referrals_referrer_user', 'referrer_user_id'),
    ('idx_affiliate_commissions_referred_org', 'referred_org_id'),
    ('idx_app_installations_installed_by', 'installed_by')
  ) AS want(name, col)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_class i
    JOIN pg_index x ON x.indexrelid = i.oid
    JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = (x.indkey::int2[])[0]
    WHERE i.relname = want.name AND a.attname = want.col);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      '1023: index name(s) present but not leading with the foreign-key column: %', missing;
  END IF;
END
$$;
