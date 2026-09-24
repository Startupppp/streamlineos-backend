-- 1128 — Recruitment: WhatsApp opt-in on the candidate
--
-- Two timestamps rather than a status enum. DPDP asks when consent was given
-- and when it was withdrawn, and a single OPTED_IN/OPTED_OUT column answers
-- neither — it also loses the distinction between somebody who opted out and
-- somebody who was never asked, which is exactly the pair a send gate must tell
-- apart.
--
-- Not a consent table: `hr_*` is frozen, there is one decision per candidate
-- per channel, and nothing joins to it. The CRM's own contact-channel consent
-- table is deliberately untouched — it is keyed on a CRM contact and candidates
-- are not contacts.
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "candidates" ADD COLUMN "whatsapp_opt_in_at" timestamp;
--> statement-breakpoint
ALTER TABLE "candidates" ADD COLUMN "whatsapp_opt_out_at" timestamp;
--> statement-breakpoint
-- Inbound WhatsApp arrives with a phone number and nothing else, so the lookup
-- that links a message to a candidate is by phone within one organisation.
CREATE INDEX IF NOT EXISTS "idx_candidates_org_phone"
  ON "candidates" ("org_id", "phone")
  WHERE "phone" IS NOT NULL;
