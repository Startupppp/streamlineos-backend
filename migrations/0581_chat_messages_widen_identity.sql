-- c21-04: widen the chat identity from int4 before volume can reach 2,147,483,647.
--
-- `chat_messages.id` is `integer`. The stated projection is five million users over two years and
-- roughly ten billion rows across the growing tables, so int4 is not a distant ceiling -- it is
-- inside the plan. SCH-001 already did this for `notifications.id` "while the table held 3 rows";
-- this is the same move for chat, for the same reason, at the same cheap moment.
--
-- This is the EXPAND half and it is deliberately alone. c21-04's own todo says not to combine a
-- blocking rewrite with the partition cutover: both rewrite the table, and doing them in one
-- migration means one long ACCESS EXCLUSIVE window instead of two short ones, with no point in
-- between where you can stop and check. Partitioning is a separate migration.
--
-- Order is children-then-parent so the schema is never narrower-references-wider at any point --
-- Postgres permits an int4 column referencing an int8 key, which is exactly why that state is
-- silent and worth not passing through. `src/db/fk-type-consistency.spec.ts` fails on it.
--
-- Five columns move, all int4 -> int8:
--   chat_attachments.message_id       -> chat_messages.id
--   chat_pinned_messages.message_id   -> chat_messages.id
--   chat_saved_messages.message_id    -> chat_messages.id
--   chat_reply_reminders.message_id   -> chat_messages.id
--   chat_messages.reply_to_id         -> chat_messages.id   (self-referencing)
-- then chat_messages.id itself.
--
-- OPERATOR: after this applies, run
--     VACUUM ANALYZE chat_messages, chat_attachments, chat_pinned_messages,
--                    chat_saved_messages, chat_reply_reminders;
-- Every ALTER TYPE here rewrites its table, which invalidates the planner statistics AND empties
-- the visibility map. One table in this codebase went 53 -> 201,875 blocks for skipping it, and a
-- count stayed wrong until VACUUM specifically.
--
-- The identity sequence does not need touching: ALTER COLUMN TYPE on a
-- GENERATED ALWAYS AS IDENTITY column carries the sequence with it.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "chat_attachments"
  ALTER COLUMN "message_id" TYPE bigint;
--> statement-breakpoint
ALTER TABLE "chat_pinned_messages"
  ALTER COLUMN "message_id" TYPE bigint;
--> statement-breakpoint
ALTER TABLE "chat_saved_messages"
  ALTER COLUMN "message_id" TYPE bigint;
--> statement-breakpoint
ALTER TABLE "chat_reply_reminders"
  ALTER COLUMN "message_id" TYPE bigint;
--> statement-breakpoint
ALTER TABLE "chat_messages"
  ALTER COLUMN "reply_to_id" TYPE bigint;
--> statement-breakpoint
ALTER TABLE "chat_messages"
  ALTER COLUMN "id" TYPE bigint;
