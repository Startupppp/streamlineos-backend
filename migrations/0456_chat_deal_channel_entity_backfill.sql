-- Collapse the two ways a chat channel could point at a business record onto one.
--
-- A channel could say "I am about that record" through the (entity_type, entity_id) pair, or,
-- for deals only, through a dedicated linked_deal_id foreign key sitting in the next column.
-- CRM created its channels one way and every other module the other, so "find the channel for
-- this record" had two answers depending on which module you arrived from.
--
-- This is the backfill half of an additive change: copy the deal links onto the pair, and leave
-- linked_deal_id in place, unread. Dropping the column is a later migration, once no deployed
-- build still reads it.
--
-- The WHERE guard is not cosmetic. A deal that already has a pair-addressed channel would
-- otherwise gain a second one claiming the same (org, type, id), and getOrCreateEntityChannel
-- returns findFirst — it would pick one arbitrarily and strand the conversation in the other.
SET lock_timeout = '5s';
--> statement-breakpoint
UPDATE "chat_channels" AS c
SET "entity_type" = 'deal',
    "entity_id" = c."linked_deal_id"::text
WHERE c."linked_deal_id" IS NOT NULL
  AND c."entity_type" IS NULL
  AND c."entity_id" IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "chat_channels" AS other
    WHERE other."org_id" = c."org_id"
      AND other."entity_type" = 'deal'
      AND other."entity_id" = c."linked_deal_id"::text
      AND other."id" <> c."id"
  );
--> statement-breakpoint
-- Until now the pair was read only by the entity-channel route; it is now the only path to a
-- record's channel, including every deal. chat_channels is one row per conversation rather than
-- per message, so a plain CREATE INDEX is cheap here and needs no CONCURRENTLY.
-- org_id leads because the policy qualifier is not leakproof, so an index without it is ignored.
CREATE INDEX IF NOT EXISTS "idx_chat_channels_org_entity"
  ON "chat_channels" ("org_id", "entity_type", "entity_id");
