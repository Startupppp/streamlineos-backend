-- Custom SQL migration file, put your code below! --

-- The storage the outbound loop has never had, and the two CHECKs that would
-- have refused its first two writes.
--
-- Phase 4 tickets 07, 08 and 09. `db/schema/crm/outbound.ts` declares four
-- tables and no migration in this repository has ever created any of them: a
-- grep of every `migrations/*.sql` for `crm_outbound_messages`,
-- `crm_outbound_class_stops`, `crm_cold_outbound_settings` and
-- `crm_sending_domains` returns nothing. Because `crm/index.ts` re-exports the
-- file, those table objects are inside the `schema` object handed to `drizzle()`
-- — so a query against them typechecks, lints and then fails at runtime with
-- 42P01. This is the same shape as 0533: the declarations shipped, the storage
-- did not, and nothing said so.
--
-- The drift is wider than four missing tables, and that is the half that is easy
-- to miss. `autonomous_decisions` still carries 0219's
-- CHECK (kind IN (... ,'quote.sent')) with no later widening anywhere, while
-- `DECISION_KINDS` in TypeScript has grown three members since: `outbound.sent`,
-- `cold_outbound.sent` and `field.repaired`. The ledger row is the FIRST write a
-- hold performs, so an outbound send does not get as far as its own table — it
-- dies at 23514 on a constraint whose text nobody had read in a year. Widened to
-- the whole TypeScript union rather than to the two kinds this ticket needs,
-- because `field.repaired` is dead the same way today and leaving it out would
-- mean the next reader has to make this discovery a third time.
--
-- `autonomy_holds` has the same problem twice over: 0228 built it with
-- CHECK (kind IN ('quote.sent')) and CHECK (quote_id IS NOT NULL) and no
-- `outbound_message_id` column at all, so a hold physically cannot point at an
-- outbound message. `autonomy-holds.ts`'s docblock claims `chk_autonomy_holds_arc`
-- (migration 0530) already enforces the exclusive arc; it does not — 0530 creates
-- the deal-forecast tables and `chk_autonomy_holds_arc` appears in no migration
-- in the repository. This creates it for real.
--
-- Authored from the Drizzle declarations, column for column, rather than from a
-- diff tool: `drizzle-kit generate` is unusable here (see 0205).

SET lock_timeout = '5s';

-- ── The messages themselves ─────────────────────────────────────────────────

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm_outbound_messages" (
  "outbound_message_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,

  -- A party rather than an address. The frequency cap is per party across every
  -- loop, and a customer with a work address and a personal one would otherwise
  -- get one message on each while every cap reported itself as respected.
  "party_id" text NOT NULL,
  "contact_id" integer,
  "deal_id" text,

  "outbound_class" text NOT NULL,
  "track" text NOT NULL,
  "channel" text DEFAULT 'EMAIL' NOT NULL,

  "subject" text NOT NULL,
  "body" text NOT NULL,

  -- Null until it leaves. The address is re-resolved at send time -- a contact
  -- who changed their mail during the hold window must not receive it at the old
  -- one -- so writing it at draft time would record a claim the send did not
  -- honour.
  "recipient_email" text,

  "status" text DEFAULT 'drafted' NOT NULL,
  "blocked_reason" text,
  "working_hour_deferrals" integer DEFAULT 0 NOT NULL,
  "timezone_used" text,
  "timezone_source" text,

  "autonomous_decision_id" text NOT NULL,
  "model" text,
  "prompt_version" text,

  "sent_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
ALTER TABLE "crm_outbound_messages" ADD CONSTRAINT "chk_crm_outbound_messages_status"
  CHECK ("status" IN ('drafted', 'held', 'sent', 'cancelled', 'blocked', 'failed'));

--> statement-breakpoint
-- The class vocabulary is `outbound-classes.ts`, which writes it as a total map
-- so a sixth class is a compile error. This is the same enumeration seen from
-- the other side: a class the database has never heard of is a row nobody can
-- filter, and the class is what a stop in `crm_outbound_class_stops` names.
ALTER TABLE "crm_outbound_messages" ADD CONSTRAINT "chk_crm_outbound_messages_class"
  CHECK ("outbound_class" IN ('follow_up', 'nudge', 'check_in', 'meeting_request', 'cold_outreach'));

--> statement-breakpoint
-- Derived from the class and stored so a query can filter it -- and constrained
-- so it cannot disagree with the class it was derived from. A `cold_outreach`
-- row carrying `engaged` would be counted against the wrong ramp and would slip
-- past the cold gate's own daily count entirely.
ALTER TABLE "crm_outbound_messages" ADD CONSTRAINT "chk_crm_outbound_messages_track"
  CHECK (
    ("outbound_class" = 'cold_outreach' AND "track" = 'cold') OR
    ("outbound_class" <> 'cold_outreach' AND "track" = 'engaged')
  );

--> statement-breakpoint
ALTER TABLE "crm_outbound_messages" ADD CONSTRAINT "chk_crm_outbound_messages_tz_source"
  CHECK ("timezone_source" IS NULL OR "timezone_source" IN ('party', 'tenant'));

--> statement-breakpoint
-- A send is a moment and an address together, or neither. A row at `sent` with
-- no `sent_at` cannot be counted by the frequency cap -- which reads `sent_at`
-- and would silently omit it -- and that omission spends the cap on a message
-- that already left.
ALTER TABLE "crm_outbound_messages" ADD CONSTRAINT "chk_crm_outbound_messages_sent"
  CHECK (
    ("status" = 'sent' AND "sent_at" IS NOT NULL AND "recipient_email" IS NOT NULL) OR
    ("status" <> 'sent' AND "sent_at" IS NULL)
  );

--> statement-breakpoint
-- Deferrals are bounded in `send-guardrails.ts` at MAX_WORKING_HOUR_DEFERRALS.
-- The database refuses a negative one rather than the ceiling, because the
-- ceiling is enforcement and belongs in one place; a negative count is corruption.
ALTER TABLE "crm_outbound_messages" ADD CONSTRAINT "chk_crm_outbound_messages_deferrals"
  CHECK ("working_hour_deferrals" >= 0);

--> statement-breakpoint
ALTER TABLE "crm_outbound_messages" ADD CONSTRAINT "fk_crm_outbound_messages_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "crm_outbound_messages" VALIDATE CONSTRAINT "fk_crm_outbound_messages_org";

--> statement-breakpoint
-- The composite tenant key `autonomy_holds` needs to point here, so the
-- reference carries the organisation with it rather than trusting the id alone.
ALTER TABLE "crm_outbound_messages" ADD CONSTRAINT "uniq_crm_outbound_messages_org_id"
  UNIQUE ("organization_id", "outbound_message_id");

--> statement-breakpoint
-- The frequency cap's read: everything sent to one party, newest first. Partial
-- on `sent`, because that is the only status the cap counts and it is a small
-- slice of a table that only grows.
CREATE INDEX IF NOT EXISTS "idx_crm_outbound_party_sent"
  ON "crm_outbound_messages" ("organization_id", "party_id", "sent_at")
  WHERE "status" = 'sent';

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_crm_outbound_org_created"
  ON "crm_outbound_messages" ("organization_id", "created_at");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_crm_outbound_decision"
  ON "crm_outbound_messages" ("organization_id", "autonomous_decision_id");

--> statement-breakpoint
-- The cold track's daily count and its bounce reconciliation.
CREATE INDEX IF NOT EXISTS "idx_crm_outbound_track_sent"
  ON "crm_outbound_messages" ("organization_id", "track", "sent_at")
  WHERE "status" = 'sent';

--> statement-breakpoint
ALTER TABLE "crm_outbound_messages" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "crm_outbound_messages";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_outbound_messages"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "crm_outbound_messages" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "crm_outbound_messages" TO streamline_app;

-- ── A class of message, stopped for one party ───────────────────────────────

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm_outbound_class_stops" (
  "outbound_class_stop_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "party_id" text NOT NULL,
  "outbound_class" text NOT NULL,

  -- The message whose cancellation caused this, so the reviewer can read it.
  "outbound_message_id" text,
  "reason" text,
  -- Plain text, never a foreign key to `users`: see 0223. Losing the record of
  -- who stopped a customer message because they later left is the wrong trade.
  "stopped_by_user_id" text,
  "stopped_at" timestamp DEFAULT now() NOT NULL,

  -- Null while the stop is live. Cleared only by a person.
  "released_at" timestamp,
  "released_by_user_id" text
);

--> statement-breakpoint
ALTER TABLE "crm_outbound_class_stops" ADD CONSTRAINT "chk_crm_outbound_class_stops_class"
  CHECK ("outbound_class" IN ('follow_up', 'nudge', 'check_in', 'meeting_request', 'cold_outreach'));

--> statement-breakpoint
ALTER TABLE "crm_outbound_class_stops" ADD CONSTRAINT "fk_crm_outbound_class_stops_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "crm_outbound_class_stops" VALIDATE CONSTRAINT "fk_crm_outbound_class_stops_org";

--> statement-breakpoint
-- One live stop per (party, class). A second would make "is this stopped" depend
-- on which row a query happened to read, and releasing one of two would look
-- like it had worked.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_crm_outbound_class_stops_live"
  ON "crm_outbound_class_stops" ("organization_id", "party_id", "outbound_class")
  WHERE "released_at" IS NULL;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_crm_outbound_class_stops_party"
  ON "crm_outbound_class_stops" ("organization_id", "party_id", "stopped_at");

--> statement-breakpoint
ALTER TABLE "crm_outbound_class_stops" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "crm_outbound_class_stops";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_outbound_class_stops"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "crm_outbound_class_stops" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "crm_outbound_class_stops" TO streamline_app;

-- ── Whether this tenant may run cold outbound at all ────────────────────────

--> statement-breakpoint
-- `enabled` defaults to false and -- deliberately -- the ABSENCE of a row means
-- the same thing. A tenant that has never heard of this feature and a tenant
-- that turned it off must be indistinguishable to the gate, because the gate is
-- the only thing between an unconfigured tenant and a cold campaign.
CREATE TABLE IF NOT EXISTS "crm_cold_outbound_settings" (
  "organization_id" text PRIMARY KEY NOT NULL,

  "enabled" boolean DEFAULT false NOT NULL,
  "enabled_at" timestamp,
  -- No FK to users: an offboarding must not silently re-enable the track.
  "enabled_by_user_id" text,

  -- Set by the track itself when bounces or complaints cross their ceiling.
  -- Nobody decides this; the send path writes it and refuses. Cleared only by a
  -- person, on purpose -- a pause that expires on its own is a pause that
  -- resumes sending into whatever caused it.
  "paused_at" timestamp,
  "pause_reason" text,
  "paused_by_user_id" text,

  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
ALTER TABLE "crm_cold_outbound_settings" ADD CONSTRAINT "fk_crm_cold_outbound_settings_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "crm_cold_outbound_settings" VALIDATE CONSTRAINT "fk_crm_cold_outbound_settings_org";

--> statement-breakpoint
-- A pause is a moment and a reason together, or neither. `evaluateColdGate`
-- reports `paused` from the timestamp alone, so a pause with no reason is a
-- refusal an operator cannot act on and will clear without reading.
ALTER TABLE "crm_cold_outbound_settings" ADD CONSTRAINT "chk_crm_cold_outbound_settings_pause"
  CHECK (("paused_at" IS NULL AND "pause_reason" IS NULL) OR ("paused_at" IS NOT NULL AND "pause_reason" IS NOT NULL));

--> statement-breakpoint
ALTER TABLE "crm_cold_outbound_settings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "crm_cold_outbound_settings";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_cold_outbound_settings"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "crm_cold_outbound_settings" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "crm_cold_outbound_settings" TO streamline_app;

-- ── The domains a tenant sends from, and what each is for ───────────────────

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm_sending_domains" (
  "sending_domain_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,

  "domain" text NOT NULL,
  "purpose" text NOT NULL,

  -- DNS proved. Until then the domain sends nothing on the cold track.
  "verified_at" timestamp,
  -- The day the ramp starts counting from. Null means warm-up never began.
  "warmup_started_at" timestamp,

  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
ALTER TABLE "crm_sending_domains" ADD CONSTRAINT "chk_crm_sending_domains_purpose"
  CHECK ("purpose" IN ('transactional', 'cold'));

--> statement-breakpoint
ALTER TABLE "crm_sending_domains" ADD CONSTRAINT "fk_crm_sending_domains_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "crm_sending_domains" VALIDATE CONSTRAINT "fk_crm_sending_domains_org";

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_crm_sending_domains_org_domain"
  ON "crm_sending_domains" ("organization_id", "domain");

--> statement-breakpoint
-- One cold domain per tenant. Two would let a tenant run each up to its own ramp
-- and send double the volume the schedule permits, which is the ramp not
-- existing.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_crm_sending_domains_cold"
  ON "crm_sending_domains" ("organization_id")
  WHERE "purpose" = 'cold';

--> statement-breakpoint
ALTER TABLE "crm_sending_domains" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "crm_sending_domains";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_sending_domains"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "crm_sending_domains" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "crm_sending_domains" TO streamline_app;

-- ── The two CHECKs that would have refused the first two writes ─────────────

--> statement-breakpoint
-- Widened to the whole of `DECISION_KINDS`. Three members have been added in
-- TypeScript since 0219 wrote this constraint and none of them reached the
-- database, so `outbound.sent`, `cold_outbound.sent` and `field.repaired` are
-- all 23514 today. The ledger insert is the first write every autonomy path
-- makes, which is why this is not a cosmetic widening: without it the outbound
-- hold fails before it has a row of its own to fail against.
ALTER TABLE "autonomous_decisions" DROP CONSTRAINT IF EXISTS "chk_autonomous_decisions_kind";
--> statement-breakpoint
ALTER TABLE "autonomous_decisions" ADD CONSTRAINT "chk_autonomous_decisions_kind"
  CHECK ("kind" IN (
    'task.extracted',
    'stage.advanced',
    'party.created',
    'activity.logged',
    'quote.sent',
    'outbound.sent',
    'cold_outbound.sent',
    'field.repaired'
  ));

--> statement-breakpoint
-- Cold is its own kind rather than a flavour of `outbound.sent`, so
-- `cancelInFlight` can stop every waiting cold message when the cold kill switch
-- goes off without touching the follow-ups.
ALTER TABLE "autonomy_holds" DROP CONSTRAINT IF EXISTS "chk_autonomy_holds_kind";
--> statement-breakpoint
ALTER TABLE "autonomy_holds" ADD CONSTRAINT "chk_autonomy_holds_kind"
  CHECK ("kind" IN ('quote.sent', 'outbound.sent', 'cold_outbound.sent'));

--> statement-breakpoint
ALTER TABLE "autonomy_holds" ADD COLUMN IF NOT EXISTS "outbound_message_id" text;

--> statement-breakpoint
ALTER TABLE "autonomy_holds" ADD CONSTRAINT "fk_autonomy_holds_outbound_message"
  FOREIGN KEY ("organization_id", "outbound_message_id")
  REFERENCES "crm_outbound_messages"("organization_id", "outbound_message_id")
  ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "autonomy_holds" VALIDATE CONSTRAINT "fk_autonomy_holds_outbound_message";

--> statement-breakpoint
-- The exclusive arc, for real this time.
--
-- 0228 wrote `chk_autonomy_holds_target` as CHECK (quote_id IS NOT NULL), which
-- is not an arc -- it forbids the outbound arm outright and would permit a row
-- with both columns set. `autonomy-holds.ts` has meanwhile claimed since ticket
-- 07 that `chk_autonomy_holds_arc` enforces "exactly one of these is set"; it
-- named a constraint that existed in no migration. `num_nonnulls` states the
-- property directly, so a hold that points at nothing -- which would wait out
-- its window and then have nothing to send -- and a hold that points at two
-- things are both refused.
ALTER TABLE "autonomy_holds" DROP CONSTRAINT IF EXISTS "chk_autonomy_holds_target";
--> statement-breakpoint
ALTER TABLE "autonomy_holds" DROP CONSTRAINT IF EXISTS "chk_autonomy_holds_arc";
--> statement-breakpoint
ALTER TABLE "autonomy_holds" ADD CONSTRAINT "chk_autonomy_holds_arc"
  CHECK (num_nonnulls("quote_id", "outbound_message_id") = 1);

--> statement-breakpoint
-- One live hold per message, for the same reason there is one per quote: two
-- decisions to send the same draft are a duplicate, not a race to win. This is
-- also the index whose 23505 `holdOutboundSend` catches and turns into a 409.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_autonomy_holds_live_outbound"
  ON "autonomy_holds" ("organization_id", "outbound_message_id")
  WHERE "status" = 'held';

--> statement-breakpoint
ANALYZE "crm_outbound_messages";
--> statement-breakpoint
ANALYZE "crm_outbound_class_stops";
--> statement-breakpoint
ANALYZE "crm_cold_outbound_settings";
--> statement-breakpoint
ANALYZE "crm_sending_domains";
--> statement-breakpoint
ANALYZE "autonomy_holds";
