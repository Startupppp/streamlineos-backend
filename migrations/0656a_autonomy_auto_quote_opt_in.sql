-- The opt-in that lets a stage advance draft a quote into the hold window.
--
-- Added default FALSE and NOT NULL together, which is a catalog-only change on
-- PG11+ — no table rewrite, so the ACCESS EXCLUSIVE lock is held for the length
-- of a catalog update rather than a scan of the table. `autonomy_settings` is
-- one row per organisation and small either way; the lock_timeout is here
-- because the rule is the rule, not because this one is expected to queue.
--
-- FALSE rather than TRUE on purpose. `resolveSwitch` is default-on — the kill
-- switches exist to stop autonomy, not to opt into it — so had the quote leg
-- been gated on `autonomy_switches` alone, deploying it would have started
-- drafting quotes for every tenant that had never asked for one. A quote
-- carries figures a customer can act on, and "nobody turned it off" is not
-- consent to send one.

SET lock_timeout = '5s';

ALTER TABLE autonomy_settings
  ADD COLUMN IF NOT EXISTS auto_quote_enabled boolean NOT NULL DEFAULT false;
