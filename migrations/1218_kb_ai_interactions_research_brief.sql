-- 1218 — Knowledge base: kb_ai_interactions gains a research-brief lineage.
--
-- S19 audit (REQUIREMENT-LEDGER, AUDIT-L6): kb_research_briefs carries no
-- provider, model, token or cost columns, so a brief's spend is invisible next
-- to Ask's, which 1208 already closed for kb_chat_messages. The fix is not a
-- parallel table — kb_ai_interactions already carries every field a brief's AI
-- call needs (provider, model, prompt_policy_version, token counts, latency,
-- cost_credits, source_ids_with_revisions, result_state) and conversation_id /
-- message_id are already nullable, so a brief-originated row simply leaves
-- those two null and sets research_brief_id instead. One anchor table for
-- every KB AI call, chat or brief.
--
-- research_brief_id is nullable for the same reason conversation_id and
-- message_id are: a chat-originated row has no brief, and a brief-originated
-- row has no conversation or message. Nothing here forces the two lineages to
-- be mutually exclusive at the constraint level — 1208 does not do that for
-- conversation_id/message_id either — because enforcing it would require a
-- CHECK this migration cannot prove against production data it has not seen
-- (BE-59/BE-60 forbid editing 1208 to add one retroactively).
--
-- HANDOFF: authored and NOT applied by lane L6. Once applied, wire
-- KbResearchBriefService's AI call path to insert a kb_ai_interactions row
-- with research_brief_id set (mirroring how KbAskService populates
-- conversation_id/message_id), and add research-brief cost/provider fields to
-- S19's list/detail response schemas. Do not deploy service code that writes
-- this column before this migration is applied in the same environment — see
-- MEMORY.md "pending-migration-plus-live-call-site-is-a-deploy-landmine".
-- Coordinate the apply with whoever journals 1208 first if it is still
-- pending — this migration's precondition requires kb_ai_interactions to
-- already exist.
--
-- Rollback: migrations/rollback/1218_kb_ai_interactions_research_brief.down.sql
SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('public.kb_ai_interactions') IS NULL THEN
    RAISE EXCEPTION '1218 precondition: public.kb_ai_interactions is absent — apply 1208 first';
  END IF;
  IF to_regclass('public.kb_research_briefs') IS NULL THEN
    RAISE EXCEPTION '1218 precondition: public.kb_research_briefs is absent — this is not a Knowledge database';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "public"."kb_ai_interactions"
  ADD COLUMN IF NOT EXISTS "research_brief_id" integer;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_kb_ai_interactions_org_research_brief"
  ON "public"."kb_ai_interactions" ("org_id", "research_brief_id")
  WHERE "research_brief_id" IS NOT NULL;
--> statement-breakpoint

ALTER TABLE "public"."kb_ai_interactions" DROP CONSTRAINT IF EXISTS "fk_kb_ai_interactions_org_research_brief";
--> statement-breakpoint
ALTER TABLE "public"."kb_ai_interactions" ADD CONSTRAINT "fk_kb_ai_interactions_org_research_brief"
  FOREIGN KEY ("org_id", "research_brief_id") REFERENCES "public"."kb_research_briefs" ("org_id", "id")
  ON DELETE SET NULL ("research_brief_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."kb_ai_interactions" VALIDATE CONSTRAINT "fk_kb_ai_interactions_org_research_brief";
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'kb_ai_interactions' AND column_name = 'research_brief_id'
  ) THEN
    RAISE EXCEPTION '1218 postcondition: kb_ai_interactions.research_brief_id was not created';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_ai_interactions_org_research_brief'
  ) THEN
    RAISE EXCEPTION '1218 postcondition: fk_kb_ai_interactions_org_research_brief was not created';
  END IF;
END $$;
--> statement-breakpoint
