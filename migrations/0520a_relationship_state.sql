-- Custom SQL migration file, put your code below! --

-- Phase 4 ticket 01. The inbound loop gains a model of what normal looks like
-- for each relationship.
--
-- Today the loop maps an event to a consequence: a message arrives, a party is
-- resolved, an activity is filed, a next step is extracted. That is enough for
-- everything that HAPPENS and structurally incapable of noticing anything that
-- stops happening, because silence is not an event and there is nothing for a
-- mapper to be triggered by. These three tables are the shape a silence
-- judgement can be made against — when each side last spoke, how quickly this
-- particular customer normally answers, who is on the thread, and which
-- conversations exist.
--
-- Every column is derived from `activities` and `activity_participants` by
-- `foldRelationshipState`, and by nothing else. Truncate all three and the next
-- message on a relationship puts that relationship back identically; there is
-- one fold, and both the incremental writer and the rebuild call it, so the two
-- cannot drift into disagreeing about a customer.
--
-- Five things here are load-bearing.
--
-- The anchor is an EXCLUSIVE ARC — a nullable column per kind plus a CHECK that
-- exactly one is set — never an `entity_type` + `entity_id` pair. That pair is
-- banned for new tables: no foreign key, no referential integrity, no
-- `ON DELETE`, and no way to carry the composite tenant edge below.
--
-- `party_id` carries a COMPOSITE tenant foreign key, exactly as
-- `activities.party_id` does (0215), so one organisation's relationship cannot
-- reference another's party and still satisfy referential integrity.
--
-- `deal_id` is `text` and carries NO foreign key, also exactly as
-- `activities.deal_id` does and for the identical reason: `deals.id` is an
-- integer and the activity model stores whatever the anchor said it was.
-- `activity-cursors.db.spec.ts` deliberately proves a deal anchor that is not a
-- number renders as data rather than crashing, so a column that had to be
-- coercible here would refuse rows the timeline already holds.
--
-- No column is a foreign key to `users`. `scripts/purge-user.mjs` deletes every
-- row whose column references `users` regardless of the delete rule, so
-- offboarding one sales rep would erase the record of who was on which
-- conversation. See 0223, which removed exactly these edges from two other
-- tables.
--
-- The two unique indexes on the anchors are PARTIAL, because one of the two
-- columns is null on every row. That matters at the call site as well: naming a
-- partial index in an `ON CONFLICT` without repeating its predicate raises
-- 42P10, which is why `RelationshipStateService` passes `targetWhere`.
--
-- Authored by hand; see 0205 for why db:generate cannot run here.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "relationship_states" (
  "relationship_state_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,

  -- Exactly one of these. See the exclusive-arc note above.
  "party_id" text,
  "deal_id" text,

  -- The oldest activity the window kept. The window is a COUNT and never a
  -- duration: a "last ninety days" bound would make the answer depend on when
  -- it was asked, so tomorrow's rebuild would differ from today's maintained
  -- state with no activity having changed -- and "rebuilding produces the
  -- identical state" would be false by construction rather than by accident.
  "observed_from" timestamp,

  "last_contact_at" timestamp,
  "last_inbound_at" timestamp,
  "last_outbound_at" timestamp,

  -- Pointers for a reader, not edges. No foreign key to `activities`: a
  -- soft-deleted activity is still the last thing that happened, and a cascade
  -- here would silently rewrite the relationship's history.
  "last_inbound_activity_id" text,
  "last_outbound_activity_id" text,

  -- When the ball entered their court; null when it is our turn. The FIRST
  -- unanswered outbound of the current run rather than the last, so chasing
  -- somebody three times in an hour does not restart their clock. A timestamp
  -- rather than a flag because the question is how long it has been their turn,
  -- and a boolean has no answer to that.
  "awaiting_reply_since" timestamp,

  "contact_count" integer DEFAULT 0 NOT NULL,
  "inbound_count" integer DEFAULT 0 NOT NULL,
  "outbound_count" integer DEFAULT 0 NOT NULL,

  -- Activities whose direction could not be read. Counted rather than guessed:
  -- a direction we cannot read is not a direction we may assume -- the same rule
  -- the telephony adapter already applies to a provider that states none -- and
  -- a baseline built on guesses is worse than no baseline. Carrying the number
  -- makes the gap visible instead of silent.
  "unreadable_direction_count" integer DEFAULT 0 NOT NULL,

  -- The reply-latency distribution, as percentiles rather than a mean. A mean is
  -- the one summary that cannot support a silence judgement: a customer who
  -- usually answers within the hour and once took a fortnight has a mean nobody
  -- would recognise, and a threshold built on it stays quiet for a week.
  "reply_sample_count" integer DEFAULT 0 NOT NULL,
  "reply_p50_seconds" integer,
  "reply_p90_seconds" integer,
  "reply_min_seconds" integer,
  "reply_max_seconds" integer,

  "participant_count" integer DEFAULT 0 NOT NULL,
  "thread_count" integer DEFAULT 0 NOT NULL,

  -- When the fold last ran. Metadata about the materialisation rather than part
  -- of the state: two rows built from the same activities differ here and are
  -- still identical.
  "built_at" timestamp DEFAULT now() NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "relationship_states" ADD CONSTRAINT "chk_relationship_states_one_anchor"
  CHECK (
    ("party_id" IS NOT NULL AND "deal_id" IS NULL) OR
    ("party_id" IS NULL AND "deal_id" IS NOT NULL)
  );
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
-- Counts and durations are counts and durations. A negative reply latency is a
-- clock problem upstream, and storing it would put a nonsense number into the
-- baseline every downstream judgement is built on.
ALTER TABLE "relationship_states" ADD CONSTRAINT "chk_relationship_states_counts"
  CHECK (
    "contact_count" >= 0 AND "inbound_count" >= 0 AND "outbound_count" >= 0 AND
    "unreadable_direction_count" >= 0 AND "reply_sample_count" >= 0 AND
    "participant_count" >= 0 AND "thread_count" >= 0 AND
    ("reply_p50_seconds" IS NULL OR "reply_p50_seconds" >= 0) AND
    ("reply_p90_seconds" IS NULL OR "reply_p90_seconds" >= 0) AND
    ("reply_min_seconds" IS NULL OR "reply_min_seconds" >= 0) AND
    ("reply_max_seconds" IS NULL OR "reply_max_seconds" >= 0)
  );
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
-- A distribution with no samples must not carry percentiles, and one with
-- samples must. The pair is what ticket 02 branches on to decide whether it may
-- use this relationship's own baseline or must fall back to a stated default,
-- and a half-populated row would let it fabricate one.
ALTER TABLE "relationship_states" ADD CONSTRAINT "chk_relationship_states_latency"
  CHECK (
    ("reply_sample_count" = 0 AND "reply_p50_seconds" IS NULL AND "reply_p90_seconds" IS NULL
       AND "reply_min_seconds" IS NULL AND "reply_max_seconds" IS NULL) OR
    ("reply_sample_count" > 0 AND "reply_p50_seconds" IS NOT NULL AND "reply_p90_seconds" IS NOT NULL
       AND "reply_min_seconds" IS NOT NULL AND "reply_max_seconds" IS NOT NULL)
  );
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "relationship_states" ADD CONSTRAINT "fk_relationship_states_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "relationship_states" VALIDATE CONSTRAINT "fk_relationship_states_org";

--> statement-breakpoint
/*
 * The composite foreign key below needs a unique constraint on exactly
 * ("organization_id", "party_id"). It is present in the live database, but a
 * database built purely by running migrations in order would abort here with
 * `42830: there is no unique constraint matching given keys` if it were only a
 * Drizzle declaration or only an index. Promotes the existing unique index
 * rather than duplicating it, following 0214, 0250 and 0290.
 */
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_business_parties_org_party') THEN
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'uniq_business_parties_org_party' AND relkind = 'i') THEN
      ALTER TABLE "business_parties"
        ADD CONSTRAINT "uniq_business_parties_org_party" UNIQUE USING INDEX "uniq_business_parties_org_party";
    ELSE
      ALTER TABLE "business_parties"
        ADD CONSTRAINT "uniq_business_parties_org_party" UNIQUE ("organization_id", "party_id");
    END IF;
  END IF;
END $$;

--> statement-breakpoint
DO $$ BEGIN
-- CASCADE rather than SET NULL: the tempting SET NULL over a composite key nulls
-- `organization_id` too, which is NOT NULL. It costs nothing here in practice --
-- parties are soft-deleted and nothing in `src/` hard-deletes one -- and the one
-- path that does fire is an organisation being torn down, where removing its
-- derived state is correct.
ALTER TABLE "relationship_states" ADD CONSTRAINT "fk_relationship_states_party"
  FOREIGN KEY ("organization_id", "party_id")
  REFERENCES "business_parties"("organization_id", "party_id") ON DELETE CASCADE NOT VALID;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "relationship_states" VALIDATE CONSTRAINT "fk_relationship_states_party";

--> statement-breakpoint
-- One state per anchor. Partial, because the other anchor column is null on
-- every row -- a plain unique index over both would let a tenant hold any number
-- of party rows, since every one of them has `deal_id IS NULL` and NULLs never
-- collide. Leading with organization_id because the RLS predicate is not
-- leakproof and the planner needs it in the index.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_relationship_states_party"
  ON "relationship_states" ("organization_id", "party_id")
  WHERE "party_id" IS NOT NULL;

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_relationship_states_deal"
  ON "relationship_states" ("organization_id", "deal_id")
  WHERE "deal_id" IS NOT NULL;

--> statement-breakpoint
-- Ticket 02's sweep: everything where it is still their turn, oldest first.
-- Partial, because a relationship whose turn it is not can never be silent and
-- has no business being scanned.
CREATE INDEX IF NOT EXISTS "idx_relationship_states_awaiting"
  ON "relationship_states" ("organization_id", "awaiting_reply_since")
  WHERE "awaiting_reply_since" IS NOT NULL;

--> statement-breakpoint
DO $$ BEGIN
-- The composite tenant key the two child tables point at.
ALTER TABLE "relationship_states" ADD CONSTRAINT "uniq_relationship_states_org_id"
  UNIQUE ("organization_id", "relationship_state_id");
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "relationship_participants" (
  "relationship_participant_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "relationship_state_id" text NOT NULL,

  -- One person, however the activity row happened to name them:
  -- `party:<id>` / `user:<id>` / `address:<normalised>`. Normalised on the way
  -- in for the same reason `party_identifiers` normalises -- Priya@Example.com
  -- and priya@example.com are one participant, and counting them as two would
  -- make "the champion stopped replying" fire the first time somebody's mail
  -- client changed its capitalisation.
  "identity" text NOT NULL,
  "party_id" text,
  -- No FK to users: see 0223. Who was on a conversation has to outlive the
  -- account of the person who was on it.
  "user_id" text,
  "address" text,

  -- Every role this person was seen in, sorted. An array here rather than a row
  -- per role because a role is an attribute of the participant and not a
  -- lifecycle entity of its own: nothing filters, paginates or soft-deletes one,
  -- and splitting them would multiply the counts below across roles, which are
  -- per person.
  "roles" text[] DEFAULT '{}' NOT NULL,

  "first_seen_at" timestamp NOT NULL,
  "last_seen_at" timestamp NOT NULL,
  "message_count" integer DEFAULT 0 NOT NULL,

  -- How many times this person was the SENDER of something that came in. The
  -- number ticket 03 reads: a champion who stops replying while a procurement
  -- contact starts is a fall in one of these and a rise in another, and nothing
  -- else in the model can say it.
  "replied_count" integer DEFAULT 0 NOT NULL,
  "last_replied_at" timestamp,

  "created_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "relationship_participants" ADD CONSTRAINT "chk_relationship_participants_identity"
  CHECK ("party_id" IS NOT NULL OR "user_id" IS NOT NULL OR "address" IS NOT NULL);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "relationship_participants" ADD CONSTRAINT "chk_relationship_participants_counts"
  CHECK ("message_count" >= 0 AND "replied_count" >= 0 AND "replied_count" <= "message_count");
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "relationship_participants" ADD CONSTRAINT "fk_relationship_participants_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "relationship_participants" VALIDATE CONSTRAINT "fk_relationship_participants_org";

--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "relationship_participants" ADD CONSTRAINT "fk_relationship_participants_state"
  FOREIGN KEY ("organization_id", "relationship_state_id")
  REFERENCES "relationship_states"("organization_id", "relationship_state_id") ON DELETE CASCADE NOT VALID;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "relationship_participants" VALIDATE CONSTRAINT "fk_relationship_participants_state";

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_relationship_participants_identity"
  ON "relationship_participants" ("organization_id", "relationship_state_id", "identity");

--> statement-breakpoint
-- The child read, and the composite foreign key's own delete-time lookup, which
-- searches on the same pair -- so one index serves both.
CREATE INDEX IF NOT EXISTS "idx_relationship_participants_state"
  ON "relationship_participants" ("organization_id", "relationship_state_id");

--> statement-breakpoint
-- The reverse read: every relationship this party appears on.
CREATE INDEX IF NOT EXISTS "idx_relationship_participants_party"
  ON "relationship_participants" ("organization_id", "party_id")
  WHERE "party_id" IS NOT NULL;

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "relationship_threads" (
  "relationship_thread_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "relationship_state_id" text NOT NULL,

  -- Opaque, exactly as `activities.thread_id` is. Nothing below the seam knows
  -- which provider produced it.
  "thread_id" text NOT NULL,
  "subject" text,

  "first_seen_at" timestamp NOT NULL,
  "last_seen_at" timestamp NOT NULL,
  "message_count" integer DEFAULT 0 NOT NULL,
  "last_direction" text,

  -- Which conversation was live when this one started. ADJACENCY, and named for
  -- it. Nothing below the ingress seam carries a provider-stated parent --
  -- `InboundCommunicationEvent` has no In-Reply-To field and no adapter reads
  -- one -- so `parent_thread_id` would be a claim the data cannot support. What
  -- IS observable is which thread this relationship was last active on before
  -- this one began, and that is the whole of what ticket 03's fork judgement
  -- needs.
  "preceded_by_thread_id" text,

  "created_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "relationship_threads" ADD CONSTRAINT "chk_relationship_threads_direction"
  CHECK ("last_direction" IS NULL OR "last_direction" IN ('inbound', 'outbound'));
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "relationship_threads" ADD CONSTRAINT "chk_relationship_threads_counts"
  CHECK ("message_count" >= 0 AND ("preceded_by_thread_id" IS NULL OR "preceded_by_thread_id" <> "thread_id"));
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "relationship_threads" ADD CONSTRAINT "fk_relationship_threads_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "relationship_threads" VALIDATE CONSTRAINT "fk_relationship_threads_org";

--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "relationship_threads" ADD CONSTRAINT "fk_relationship_threads_state"
  FOREIGN KEY ("organization_id", "relationship_state_id")
  REFERENCES "relationship_states"("organization_id", "relationship_state_id") ON DELETE CASCADE NOT VALID;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "relationship_threads" VALIDATE CONSTRAINT "fk_relationship_threads_state";

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_relationship_threads_thread"
  ON "relationship_threads" ("organization_id", "relationship_state_id", "thread_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_relationship_threads_state"
  ON "relationship_threads" ("organization_id", "relationship_state_id");

--> statement-breakpoint
-- Which relationship a thread belongs to, read from the thread's own id -- the
-- direction ticket 03 asks in, since a fork is discovered from the new thread.
CREATE INDEX IF NOT EXISTS "idx_relationship_threads_lookup"
  ON "relationship_threads" ("organization_id", "thread_id");

--> statement-breakpoint
-- The RLS matrix, extended to all three. Without a policy each is readable
-- organisation-wide, because grants arrive through ALTER DEFAULT PRIVILEGES and
-- a missing policy is silent. These hold a summary of who a tenant talks to and
-- how quickly they answer, which is exactly as disclosive as the mail it was
-- derived from.
ALTER TABLE "relationship_states" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "relationship_states";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "relationship_states"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "relationship_states" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "relationship_states" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "relationship_participants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "relationship_participants";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "relationship_participants"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "relationship_participants" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "relationship_participants" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "relationship_threads" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "relationship_threads";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "relationship_threads"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "relationship_threads" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "relationship_threads" TO streamline_app;

--> statement-breakpoint
ANALYZE "relationship_states";
--> statement-breakpoint
ANALYZE "relationship_participants";
--> statement-breakpoint
ANALYZE "relationship_threads";
