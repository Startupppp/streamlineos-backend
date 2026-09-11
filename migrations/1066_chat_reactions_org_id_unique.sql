SET statement_timeout = 0;
SET lock_timeout = '5s';

-- 1066 — give chat_message_reactions the composite tenant key every other chat table has.
--
-- WHAT WAS WRONG. `backend/CLAUDE.md` §3 requires a tenant table's business key to be
-- composite so a sibling table can carry a `(org_id, <fk>)` FOREIGN KEY into it and have the
-- tenant travel with the reference. Twelve of the thirteen chat tables declare
-- `unique(org_id, id)` for exactly that reason — `uniq_chat_messages_org_id`,
-- `uniq_chat_attachments_org_id`, and so on. `chat_message_reactions` was the one that did
-- not: measured against the live catalog it carried only its primary key,
-- `uniq_chat_message_reaction_actor_emoji` and `idx_chat_message_reactions_membership`.
--
-- The consequence is not a data defect today; it is that NOTHING can compositely reference a
-- reaction row. A future table (reaction audit, moderation, digest) would have to fall back to
-- a bare `(id)` FK and lose the tenant edge, which is the class of gap the composite-key rule
-- exists to close, and the class §3 calls "the composite tenant FK defeated".
--
-- SHAPE. `id` is `generatedAlwaysAsIdentity` and `org_id` is `NOT NULL`, so `(org_id, id)` is
-- already unique for every existing row: this can never fail on data and needs no backfill.
-- The constraint is added directly rather than through `CREATE UNIQUE INDEX CONCURRENTLY` +
-- `ADD CONSTRAINT ... USING INDEX` because CONCURRENTLY cannot run inside the transaction the
-- migration runner wraps each statement in. `lock_timeout` above is what keeps the ACCESS
-- EXCLUSIVE it takes from queueing behind a long read and blocking the table.
--
-- The `DO $$ ... EXCEPTION WHEN duplicate_object` wrapper is this repository's established
-- idempotence idiom for a named constraint (0306 adds every sibling chat key the same way),
-- so a re-run on a database that already has it is a no-op rather than a failure.

DO $$ BEGIN
  ALTER TABLE "chat_message_reactions"
    ADD CONSTRAINT "uniq_chat_message_reactions_org_id" UNIQUE ("org_id","id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
