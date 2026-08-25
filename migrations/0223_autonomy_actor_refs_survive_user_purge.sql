-- Custom SQL migration file, put your code below! --

-- Two foreign keys to `users` that a user purge turns into data loss.
--
-- `scripts/purge-user.mjs` finds every column with a foreign key to `users` and
-- runs `DELETE FROM <table> WHERE <column> = $user`. It does not consult the
-- delete rule, so `ON DELETE SET NULL` does not protect anything: the row goes.
-- On these two tables that is the wrong outcome, in two different ways.
--
-- `autonomy_switches` is a safety mechanism. Purging whoever last flipped a
-- switch deletes the switch row, and `resolveSwitch` reports `allowed: true`
-- when no row is found -- correctly, because the switches exist to stop
-- autonomy rather than to opt into it. So an offboarding would silently
-- re-enable an action type an operator had killed. Nothing would log it and
-- nothing would notice until the system started acting again.
--
-- `autonomous_decisions` is the audit trail. Purging whoever reversed one
-- decision deletes the whole record of the original autonomous action, which
-- had nothing to do with that person. The reviewer loses the action, not just
-- the reverser.
--
-- That table also carried a contradiction the purge path happened to hide:
-- `ON DELETE SET NULL` on `reversed_by_user_id` against
-- `chk_autonomous_decisions_reversal`, which requires `reversed_at` and
-- `reversed_by_user_id` to be NULL together. A cascade that nulls one but not
-- the other raises 23514, so any delete path that did rely on the FK action
-- would fail outright.
--
-- Both columns become plain actor identifiers with no referential edge, which
-- is what `deal_stage_transitions.actor_user_id` already does for the same
-- reason: a ledger records who acted, and that record has to outlive the row
-- describing them. A purged user leaves an id that resolves to nobody, and the
-- feed renders it as an unknown actor -- a strictly better failure than an
-- audit entry that never existed.
--
-- Authored via `generate --custom`; see 0205 for why db:generate cannot run here.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "autonomy_switches" DROP CONSTRAINT IF EXISTS "fk_autonomy_switches_user";

--> statement-breakpoint
ALTER TABLE "autonomous_decisions" DROP CONSTRAINT IF EXISTS "fk_autonomous_decisions_reverser";
