-- =============================================================================
-- 0663 — Composite tenant foreign keys: collaboration and recruitment
-- =============================================================================
-- Chat, calendar, helpdesk and recruitment.
--
-- 71 composite tenant foreign keys.
-- Requires 0656, which authors the unique keys these reference.
--
-- Series 0656-0664. Part of one change: 458 composite tenant foreign keys and
-- the 165 unique keys they reference existed only on the shared Neon branch,
-- created by hand and authored by no migration. backend/CLAUDE.md §3 requires
-- them and says application predicates and RLS do not replace them, so on a
-- database rebuilt from migrations/ nothing stopped a child row referencing a
-- parent in another organisation.
--
-- Shape rules, all of them load-bearing:
--
--   * Every definition is taken verbatim from pg_get_constraintdef, so the
--     ON DELETE clauses that nine of them carry survive. The only edits are
--     mechanical: a trailing " NOT VALID" is stripped from the four that are
--     live-but-unvalidated (we append our own), and the REFERENCES target is
--     schema-qualified — see the next point.
--
--   * Every table name is schema-qualified in all three positions: the
--     to_regclass probe, the ALTER TABLE, and the REFERENCES target. 123 of
--     these constraints are outside public (120 build, 3 build_events), and
--     to_regclass('public.x') on a build table returns NULL — the guard would
--     conclude the table does not exist, skip, and never create the constraint
--     on a fresh build. That is the guard's protection inverted, producing
--     exactly the defect this series exists to fix. The same trap bites the
--     REFERENCES clause from the other side: this database's search_path is
--     '"$user", public, build_events, app', so pg_get_constraintdef renders
--     build_events.ticket_comments as a bare "ticket_comments", which resolves
--     to the wrong table (or to nothing) under any other search_path.
--
--   * ADD CONSTRAINT ... NOT VALID first, VALIDATE CONSTRAINT as a separate
--     statement. A one-step ADD takes ACCESS EXCLUSIVE on BOTH tables while it
--     installs the triggers, so it stalls every write to both behind any long
--     read.
--
--   * Both halves are guarded on pg_constraint via to_regclass — never
--     ::regclass, which throws on a missing table. All of these already exist
--     on the database this was written against, so each file must be a no-op
--     there and the creating statement anywhere else.
--
--   * lock_timeout so a blocked ALTER fails fast instead of queueing and
--     blocking the table behind it.
-- =============================================================================

SET lock_timeout = '5s';
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.calendar_events') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_calendar_events_org_creator_membership'
                     AND conrelid = to_regclass('public.calendar_events')) THEN
    ALTER TABLE "public"."calendar_events" ADD CONSTRAINT "fk_calendar_events_org_creator_membership" FOREIGN KEY (org_id, created_by_membership_id) REFERENCES "public"."organization_members"(org_id, id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_calendar_events_org_creator_membership'
             AND conrelid = to_regclass('public.calendar_events') AND NOT convalidated) THEN
    ALTER TABLE "public"."calendar_events" VALIDATE CONSTRAINT "fk_calendar_events_org_creator_membership";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.chat_attachments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_attachments_message_id_org'
                     AND conrelid = to_regclass('public.chat_attachments')) THEN
    ALTER TABLE "public"."chat_attachments" ADD CONSTRAINT "fk_chat_attachments_message_id_org" FOREIGN KEY (org_id, message_id) REFERENCES "public"."chat_messages"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_attachments_message_id_org'
             AND conrelid = to_regclass('public.chat_attachments') AND NOT convalidated) THEN
    ALTER TABLE "public"."chat_attachments" VALIDATE CONSTRAINT "fk_chat_attachments_message_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.chat_channel_invite_links') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_channel_invite_links_channel_id_org'
                     AND conrelid = to_regclass('public.chat_channel_invite_links')) THEN
    ALTER TABLE "public"."chat_channel_invite_links" ADD CONSTRAINT "fk_chat_channel_invite_links_channel_id_org" FOREIGN KEY (org_id, channel_id) REFERENCES "public"."chat_channels"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_channel_invite_links_channel_id_org'
             AND conrelid = to_regclass('public.chat_channel_invite_links') AND NOT convalidated) THEN
    ALTER TABLE "public"."chat_channel_invite_links" VALIDATE CONSTRAINT "fk_chat_channel_invite_links_channel_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.chat_channel_members') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_channel_members_channel_id_org'
                     AND conrelid = to_regclass('public.chat_channel_members')) THEN
    ALTER TABLE "public"."chat_channel_members" ADD CONSTRAINT "fk_chat_channel_members_channel_id_org" FOREIGN KEY (org_id, channel_id) REFERENCES "public"."chat_channels"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_channel_members_channel_id_org'
             AND conrelid = to_regclass('public.chat_channel_members') AND NOT convalidated) THEN
    ALTER TABLE "public"."chat_channel_members" VALIDATE CONSTRAINT "fk_chat_channel_members_channel_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.chat_channels') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_channels_linked_deal_id_org'
                     AND conrelid = to_regclass('public.chat_channels')) THEN
    ALTER TABLE "public"."chat_channels" ADD CONSTRAINT "fk_chat_channels_linked_deal_id_org" FOREIGN KEY (org_id, linked_deal_id) REFERENCES "public"."deals"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_channels_linked_deal_id_org'
             AND conrelid = to_regclass('public.chat_channels') AND NOT convalidated) THEN
    ALTER TABLE "public"."chat_channels" VALIDATE CONSTRAINT "fk_chat_channels_linked_deal_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.chat_channels') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_channels_org_creator_membership'
                     AND conrelid = to_regclass('public.chat_channels')) THEN
    ALTER TABLE "public"."chat_channels" ADD CONSTRAINT "fk_chat_channels_org_creator_membership" FOREIGN KEY (org_id, created_by_membership_id) REFERENCES "public"."organization_members"(org_id, id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_channels_org_creator_membership'
             AND conrelid = to_regclass('public.chat_channels') AND NOT convalidated) THEN
    ALTER TABLE "public"."chat_channels" VALIDATE CONSTRAINT "fk_chat_channels_org_creator_membership";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.chat_huddle_participants') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_huddle_participants_huddle_id_org'
                     AND conrelid = to_regclass('public.chat_huddle_participants')) THEN
    ALTER TABLE "public"."chat_huddle_participants" ADD CONSTRAINT "fk_chat_huddle_participants_huddle_id_org" FOREIGN KEY (org_id, huddle_id) REFERENCES "public"."chat_huddles"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_huddle_participants_huddle_id_org'
             AND conrelid = to_regclass('public.chat_huddle_participants') AND NOT convalidated) THEN
    ALTER TABLE "public"."chat_huddle_participants" VALIDATE CONSTRAINT "fk_chat_huddle_participants_huddle_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.chat_huddles') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_huddles_channel_id_org'
                     AND conrelid = to_regclass('public.chat_huddles')) THEN
    ALTER TABLE "public"."chat_huddles" ADD CONSTRAINT "fk_chat_huddles_channel_id_org" FOREIGN KEY (org_id, channel_id) REFERENCES "public"."chat_channels"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_huddles_channel_id_org'
             AND conrelid = to_regclass('public.chat_huddles') AND NOT convalidated) THEN
    ALTER TABLE "public"."chat_huddles" VALIDATE CONSTRAINT "fk_chat_huddles_channel_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.chat_messages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_messages_channel_id_org'
                     AND conrelid = to_regclass('public.chat_messages')) THEN
    ALTER TABLE "public"."chat_messages" ADD CONSTRAINT "fk_chat_messages_channel_id_org" FOREIGN KEY (org_id, channel_id) REFERENCES "public"."chat_channels"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_messages_channel_id_org'
             AND conrelid = to_regclass('public.chat_messages') AND NOT convalidated) THEN
    ALTER TABLE "public"."chat_messages" VALIDATE CONSTRAINT "fk_chat_messages_channel_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.chat_messages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_messages_org_sender_membership'
                     AND conrelid = to_regclass('public.chat_messages')) THEN
    ALTER TABLE "public"."chat_messages" ADD CONSTRAINT "fk_chat_messages_org_sender_membership" FOREIGN KEY (org_id, sender_membership_id) REFERENCES "public"."organization_members"(org_id, id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_messages_org_sender_membership'
             AND conrelid = to_regclass('public.chat_messages') AND NOT convalidated) THEN
    ALTER TABLE "public"."chat_messages" VALIDATE CONSTRAINT "fk_chat_messages_org_sender_membership";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.chat_messages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_messages_reply_to_id_org'
                     AND conrelid = to_regclass('public.chat_messages')) THEN
    ALTER TABLE "public"."chat_messages" ADD CONSTRAINT "fk_chat_messages_reply_to_id_org" FOREIGN KEY (org_id, reply_to_id) REFERENCES "public"."chat_messages"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_messages_reply_to_id_org'
             AND conrelid = to_regclass('public.chat_messages') AND NOT convalidated) THEN
    ALTER TABLE "public"."chat_messages" VALIDATE CONSTRAINT "fk_chat_messages_reply_to_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.chat_pinned_messages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_pinned_messages_channel_id_org'
                     AND conrelid = to_regclass('public.chat_pinned_messages')) THEN
    ALTER TABLE "public"."chat_pinned_messages" ADD CONSTRAINT "fk_chat_pinned_messages_channel_id_org" FOREIGN KEY (org_id, channel_id) REFERENCES "public"."chat_channels"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_pinned_messages_channel_id_org'
             AND conrelid = to_regclass('public.chat_pinned_messages') AND NOT convalidated) THEN
    ALTER TABLE "public"."chat_pinned_messages" VALIDATE CONSTRAINT "fk_chat_pinned_messages_channel_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.chat_pinned_messages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_pinned_messages_message_id_org'
                     AND conrelid = to_regclass('public.chat_pinned_messages')) THEN
    ALTER TABLE "public"."chat_pinned_messages" ADD CONSTRAINT "fk_chat_pinned_messages_message_id_org" FOREIGN KEY (org_id, message_id) REFERENCES "public"."chat_messages"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_pinned_messages_message_id_org'
             AND conrelid = to_regclass('public.chat_pinned_messages') AND NOT convalidated) THEN
    ALTER TABLE "public"."chat_pinned_messages" VALIDATE CONSTRAINT "fk_chat_pinned_messages_message_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.chat_reply_reminders') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_reply_reminders_channel_id_org'
                     AND conrelid = to_regclass('public.chat_reply_reminders')) THEN
    ALTER TABLE "public"."chat_reply_reminders" ADD CONSTRAINT "fk_chat_reply_reminders_channel_id_org" FOREIGN KEY (org_id, channel_id) REFERENCES "public"."chat_channels"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_reply_reminders_channel_id_org'
             AND conrelid = to_regclass('public.chat_reply_reminders') AND NOT convalidated) THEN
    ALTER TABLE "public"."chat_reply_reminders" VALIDATE CONSTRAINT "fk_chat_reply_reminders_channel_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.chat_reply_reminders') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_reply_reminders_message_id_org'
                     AND conrelid = to_regclass('public.chat_reply_reminders')) THEN
    ALTER TABLE "public"."chat_reply_reminders" ADD CONSTRAINT "fk_chat_reply_reminders_message_id_org" FOREIGN KEY (org_id, message_id) REFERENCES "public"."chat_messages"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_reply_reminders_message_id_org'
             AND conrelid = to_regclass('public.chat_reply_reminders') AND NOT convalidated) THEN
    ALTER TABLE "public"."chat_reply_reminders" VALIDATE CONSTRAINT "fk_chat_reply_reminders_message_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.chat_saved_messages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_saved_messages_message_id_org'
                     AND conrelid = to_regclass('public.chat_saved_messages')) THEN
    ALTER TABLE "public"."chat_saved_messages" ADD CONSTRAINT "fk_chat_saved_messages_message_id_org" FOREIGN KEY (org_id, message_id) REFERENCES "public"."chat_messages"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_saved_messages_message_id_org'
             AND conrelid = to_regclass('public.chat_saved_messages') AND NOT convalidated) THEN
    ALTER TABLE "public"."chat_saved_messages" VALIDATE CONSTRAINT "fk_chat_saved_messages_message_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.email_sequence_enrollments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_email_sequence_enrollments_candidate_id_org'
                     AND conrelid = to_regclass('public.email_sequence_enrollments')) THEN
    ALTER TABLE "public"."email_sequence_enrollments" ADD CONSTRAINT "fk_email_sequence_enrollments_candidate_id_org" FOREIGN KEY (org_id, candidate_id) REFERENCES "public"."candidates"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_email_sequence_enrollments_candidate_id_org'
             AND conrelid = to_regclass('public.email_sequence_enrollments') AND NOT convalidated) THEN
    ALTER TABLE "public"."email_sequence_enrollments" VALIDATE CONSTRAINT "fk_email_sequence_enrollments_candidate_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.email_sequence_enrollments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_email_sequence_enrollments_sequence_id_org'
                     AND conrelid = to_regclass('public.email_sequence_enrollments')) THEN
    ALTER TABLE "public"."email_sequence_enrollments" ADD CONSTRAINT "fk_email_sequence_enrollments_sequence_id_org" FOREIGN KEY (org_id, sequence_id) REFERENCES "public"."email_sequences"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_email_sequence_enrollments_sequence_id_org'
             AND conrelid = to_regclass('public.email_sequence_enrollments') AND NOT convalidated) THEN
    ALTER TABLE "public"."email_sequence_enrollments" VALIDATE CONSTRAINT "fk_email_sequence_enrollments_sequence_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.email_sequence_steps') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_email_sequence_steps_sequence_id_org'
                     AND conrelid = to_regclass('public.email_sequence_steps')) THEN
    ALTER TABLE "public"."email_sequence_steps" ADD CONSTRAINT "fk_email_sequence_steps_sequence_id_org" FOREIGN KEY (org_id, sequence_id) REFERENCES "public"."email_sequences"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_email_sequence_steps_sequence_id_org'
             AND conrelid = to_regclass('public.email_sequence_steps') AND NOT convalidated) THEN
    ALTER TABLE "public"."email_sequence_steps" VALIDATE CONSTRAINT "fk_email_sequence_steps_sequence_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.event_attendees') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_event_attendees_event_id_org'
                     AND conrelid = to_regclass('public.event_attendees')) THEN
    ALTER TABLE "public"."event_attendees" ADD CONSTRAINT "fk_event_attendees_event_id_org" FOREIGN KEY (org_id, event_id) REFERENCES "public"."calendar_events"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_event_attendees_event_id_org'
             AND conrelid = to_regclass('public.event_attendees') AND NOT convalidated) THEN
    ALTER TABLE "public"."event_attendees" VALIDATE CONSTRAINT "fk_event_attendees_event_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.event_attendees') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_event_attendees_org_user'
                     AND conrelid = to_regclass('public.event_attendees')) THEN
    ALTER TABLE "public"."event_attendees" ADD CONSTRAINT "fk_event_attendees_org_user" FOREIGN KEY (org_id, user_id) REFERENCES "public"."organization_members"(org_id, user_id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_event_attendees_org_user'
             AND conrelid = to_regclass('public.event_attendees') AND NOT convalidated) THEN
    ALTER TABLE "public"."event_attendees" VALIDATE CONSTRAINT "fk_event_attendees_org_user";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.support_ai_suggestions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_ai_suggestions_ticket_id_org'
                     AND conrelid = to_regclass('public.support_ai_suggestions')) THEN
    ALTER TABLE "public"."support_ai_suggestions" ADD CONSTRAINT "fk_support_ai_suggestions_ticket_id_org" FOREIGN KEY (org_id, ticket_id) REFERENCES "public"."support_tickets"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_ai_suggestions_ticket_id_org'
             AND conrelid = to_regclass('public.support_ai_suggestions') AND NOT convalidated) THEN
    ALTER TABLE "public"."support_ai_suggestions" VALIDATE CONSTRAINT "fk_support_ai_suggestions_ticket_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.support_csat_requests') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_csat_requests_ticket_id_org'
                     AND conrelid = to_regclass('public.support_csat_requests')) THEN
    ALTER TABLE "public"."support_csat_requests" ADD CONSTRAINT "fk_support_csat_requests_ticket_id_org" FOREIGN KEY (org_id, ticket_id) REFERENCES "public"."support_tickets"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_csat_requests_ticket_id_org'
             AND conrelid = to_regclass('public.support_csat_requests') AND NOT convalidated) THEN
    ALTER TABLE "public"."support_csat_requests" VALIDATE CONSTRAINT "fk_support_csat_requests_ticket_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.support_knowledge_gaps') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_knowledge_gaps_proposed_article_id_org'
                     AND conrelid = to_regclass('public.support_knowledge_gaps')) THEN
    ALTER TABLE "public"."support_knowledge_gaps" ADD CONSTRAINT "fk_support_knowledge_gaps_proposed_article_id_org" FOREIGN KEY (org_id, proposed_article_id) REFERENCES "public"."kb_articles"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_knowledge_gaps_proposed_article_id_org'
             AND conrelid = to_regclass('public.support_knowledge_gaps') AND NOT convalidated) THEN
    ALTER TABLE "public"."support_knowledge_gaps" VALIDATE CONSTRAINT "fk_support_knowledge_gaps_proposed_article_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.support_message_mentions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_message_mentions_message_id_org'
                     AND conrelid = to_regclass('public.support_message_mentions')) THEN
    ALTER TABLE "public"."support_message_mentions" ADD CONSTRAINT "fk_support_message_mentions_message_id_org" FOREIGN KEY (org_id, message_id) REFERENCES "public"."support_ticket_messages"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_message_mentions_message_id_org'
             AND conrelid = to_regclass('public.support_message_mentions') AND NOT convalidated) THEN
    ALTER TABLE "public"."support_message_mentions" VALIDATE CONSTRAINT "fk_support_message_mentions_message_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.support_ticket_activity') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_ticket_activity_support_ticket_id_org'
                     AND conrelid = to_regclass('public.support_ticket_activity')) THEN
    ALTER TABLE "public"."support_ticket_activity" ADD CONSTRAINT "fk_support_ticket_activity_support_ticket_id_org" FOREIGN KEY (org_id, support_ticket_id) REFERENCES "public"."support_tickets"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_ticket_activity_support_ticket_id_org'
             AND conrelid = to_regclass('public.support_ticket_activity') AND NOT convalidated) THEN
    ALTER TABLE "public"."support_ticket_activity" VALIDATE CONSTRAINT "fk_support_ticket_activity_support_ticket_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.support_ticket_drafts') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_ticket_drafts_ticket_id_org'
                     AND conrelid = to_regclass('public.support_ticket_drafts')) THEN
    ALTER TABLE "public"."support_ticket_drafts" ADD CONSTRAINT "fk_support_ticket_drafts_ticket_id_org" FOREIGN KEY (org_id, ticket_id) REFERENCES "public"."support_tickets"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_ticket_drafts_ticket_id_org'
             AND conrelid = to_regclass('public.support_ticket_drafts') AND NOT convalidated) THEN
    ALTER TABLE "public"."support_ticket_drafts" VALIDATE CONSTRAINT "fk_support_ticket_drafts_ticket_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.support_ticket_embeddings') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_ticket_embeddings_ticket_id_org'
                     AND conrelid = to_regclass('public.support_ticket_embeddings')) THEN
    ALTER TABLE "public"."support_ticket_embeddings" ADD CONSTRAINT "fk_support_ticket_embeddings_ticket_id_org" FOREIGN KEY (org_id, ticket_id) REFERENCES "public"."support_tickets"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_ticket_embeddings_ticket_id_org'
             AND conrelid = to_regclass('public.support_ticket_embeddings') AND NOT convalidated) THEN
    ALTER TABLE "public"."support_ticket_embeddings" VALIDATE CONSTRAINT "fk_support_ticket_embeddings_ticket_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.support_ticket_external_links') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_ticket_external_links_ticket_id_org'
                     AND conrelid = to_regclass('public.support_ticket_external_links')) THEN
    ALTER TABLE "public"."support_ticket_external_links" ADD CONSTRAINT "fk_support_ticket_external_links_ticket_id_org" FOREIGN KEY (org_id, ticket_id) REFERENCES "public"."support_tickets"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_ticket_external_links_ticket_id_org'
             AND conrelid = to_regclass('public.support_ticket_external_links') AND NOT convalidated) THEN
    ALTER TABLE "public"."support_ticket_external_links" VALIDATE CONSTRAINT "fk_support_ticket_external_links_ticket_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.support_ticket_links') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_ticket_links_linked_ticket_id_org'
                     AND conrelid = to_regclass('public.support_ticket_links')) THEN
    ALTER TABLE "public"."support_ticket_links" ADD CONSTRAINT "fk_support_ticket_links_linked_ticket_id_org" FOREIGN KEY (org_id, linked_ticket_id) REFERENCES "public"."support_tickets"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_ticket_links_linked_ticket_id_org'
             AND conrelid = to_regclass('public.support_ticket_links') AND NOT convalidated) THEN
    ALTER TABLE "public"."support_ticket_links" VALIDATE CONSTRAINT "fk_support_ticket_links_linked_ticket_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.support_ticket_messages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_ticket_messages_ticket_id_org'
                     AND conrelid = to_regclass('public.support_ticket_messages')) THEN
    ALTER TABLE "public"."support_ticket_messages" ADD CONSTRAINT "fk_support_ticket_messages_ticket_id_org" FOREIGN KEY (org_id, ticket_id) REFERENCES "public"."support_tickets"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_ticket_messages_ticket_id_org'
             AND conrelid = to_regclass('public.support_ticket_messages') AND NOT convalidated) THEN
    ALTER TABLE "public"."support_ticket_messages" VALIDATE CONSTRAINT "fk_support_ticket_messages_ticket_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.support_ticket_tags') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_ticket_tags_tag_id_org'
                     AND conrelid = to_regclass('public.support_ticket_tags')) THEN
    ALTER TABLE "public"."support_ticket_tags" ADD CONSTRAINT "fk_support_ticket_tags_tag_id_org" FOREIGN KEY (org_id, tag_id) REFERENCES "public"."support_tags"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_ticket_tags_tag_id_org'
             AND conrelid = to_regclass('public.support_ticket_tags') AND NOT convalidated) THEN
    ALTER TABLE "public"."support_ticket_tags" VALIDATE CONSTRAINT "fk_support_ticket_tags_tag_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.support_ticket_tags') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_ticket_tags_ticket_id_org'
                     AND conrelid = to_regclass('public.support_ticket_tags')) THEN
    ALTER TABLE "public"."support_ticket_tags" ADD CONSTRAINT "fk_support_ticket_tags_ticket_id_org" FOREIGN KEY (org_id, ticket_id) REFERENCES "public"."support_tickets"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_ticket_tags_ticket_id_org'
             AND conrelid = to_regclass('public.support_ticket_tags') AND NOT convalidated) THEN
    ALTER TABLE "public"."support_ticket_tags" VALIDATE CONSTRAINT "fk_support_ticket_tags_ticket_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.support_ticket_watchers') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_ticket_watchers_ticket_id_org'
                     AND conrelid = to_regclass('public.support_ticket_watchers')) THEN
    ALTER TABLE "public"."support_ticket_watchers" ADD CONSTRAINT "fk_support_ticket_watchers_ticket_id_org" FOREIGN KEY (org_id, ticket_id) REFERENCES "public"."support_tickets"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_ticket_watchers_ticket_id_org'
             AND conrelid = to_regclass('public.support_ticket_watchers') AND NOT convalidated) THEN
    ALTER TABLE "public"."support_ticket_watchers" VALIDATE CONSTRAINT "fk_support_ticket_watchers_ticket_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.calibration_participants') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_calibration_participants_session_id_org'
                     AND conrelid = to_regclass('public.calibration_participants')) THEN
    ALTER TABLE "public"."calibration_participants" ADD CONSTRAINT "fk_calibration_participants_session_id_org" FOREIGN KEY (org_id, session_id) REFERENCES "public"."calibration_sessions"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_calibration_participants_session_id_org'
             AND conrelid = to_regclass('public.calibration_participants') AND NOT convalidated) THEN
    ALTER TABLE "public"."calibration_participants" VALIDATE CONSTRAINT "fk_calibration_participants_session_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.calibration_sessions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_calibration_sessions_candidate_id_org'
                     AND conrelid = to_regclass('public.calibration_sessions')) THEN
    ALTER TABLE "public"."calibration_sessions" ADD CONSTRAINT "fk_calibration_sessions_candidate_id_org" FOREIGN KEY (org_id, candidate_id) REFERENCES "public"."candidates"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_calibration_sessions_candidate_id_org'
             AND conrelid = to_regclass('public.calibration_sessions') AND NOT convalidated) THEN
    ALTER TABLE "public"."calibration_sessions" VALIDATE CONSTRAINT "fk_calibration_sessions_candidate_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.calibration_sessions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_calibration_sessions_job_posting_id_org'
                     AND conrelid = to_regclass('public.calibration_sessions')) THEN
    ALTER TABLE "public"."calibration_sessions" ADD CONSTRAINT "fk_calibration_sessions_job_posting_id_org" FOREIGN KEY (org_id, job_posting_id) REFERENCES "public"."job_postings"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_calibration_sessions_job_posting_id_org'
             AND conrelid = to_regclass('public.calibration_sessions') AND NOT convalidated) THEN
    ALTER TABLE "public"."calibration_sessions" VALIDATE CONSTRAINT "fk_calibration_sessions_job_posting_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.candidate_applications') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_applications_candidate_id_org'
                     AND conrelid = to_regclass('public.candidate_applications')) THEN
    ALTER TABLE "public"."candidate_applications" ADD CONSTRAINT "fk_candidate_applications_candidate_id_org" FOREIGN KEY (org_id, candidate_id) REFERENCES "public"."candidates"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_applications_candidate_id_org'
             AND conrelid = to_regclass('public.candidate_applications') AND NOT convalidated) THEN
    ALTER TABLE "public"."candidate_applications" VALIDATE CONSTRAINT "fk_candidate_applications_candidate_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.candidate_applications') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_applications_job_posting_id_org'
                     AND conrelid = to_regclass('public.candidate_applications')) THEN
    ALTER TABLE "public"."candidate_applications" ADD CONSTRAINT "fk_candidate_applications_job_posting_id_org" FOREIGN KEY (org_id, job_posting_id) REFERENCES "public"."job_postings"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_applications_job_posting_id_org'
             AND conrelid = to_regclass('public.candidate_applications') AND NOT convalidated) THEN
    ALTER TABLE "public"."candidate_applications" VALIDATE CONSTRAINT "fk_candidate_applications_job_posting_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.candidate_documents') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_documents_candidate_id_org'
                     AND conrelid = to_regclass('public.candidate_documents')) THEN
    ALTER TABLE "public"."candidate_documents" ADD CONSTRAINT "fk_candidate_documents_candidate_id_org" FOREIGN KEY (org_id, candidate_id) REFERENCES "public"."candidates"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_documents_candidate_id_org'
             AND conrelid = to_regclass('public.candidate_documents') AND NOT convalidated) THEN
    ALTER TABLE "public"."candidate_documents" VALIDATE CONSTRAINT "fk_candidate_documents_candidate_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.candidate_documents') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_documents_template_id_org'
                     AND conrelid = to_regclass('public.candidate_documents')) THEN
    ALTER TABLE "public"."candidate_documents" ADD CONSTRAINT "fk_candidate_documents_template_id_org" FOREIGN KEY (org_id, template_id) REFERENCES "public"."document_templates"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_documents_template_id_org'
             AND conrelid = to_regclass('public.candidate_documents') AND NOT convalidated) THEN
    ALTER TABLE "public"."candidate_documents" VALIDATE CONSTRAINT "fk_candidate_documents_template_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.candidate_documents_vault') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_documents_vault_candidate_id_org'
                     AND conrelid = to_regclass('public.candidate_documents_vault')) THEN
    ALTER TABLE "public"."candidate_documents_vault" ADD CONSTRAINT "fk_candidate_documents_vault_candidate_id_org" FOREIGN KEY (org_id, candidate_id) REFERENCES "public"."candidates"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_documents_vault_candidate_id_org'
             AND conrelid = to_regclass('public.candidate_documents_vault') AND NOT convalidated) THEN
    ALTER TABLE "public"."candidate_documents_vault" VALIDATE CONSTRAINT "fk_candidate_documents_vault_candidate_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.candidate_messages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_messages_candidate_id_org'
                     AND conrelid = to_regclass('public.candidate_messages')) THEN
    ALTER TABLE "public"."candidate_messages" ADD CONSTRAINT "fk_candidate_messages_candidate_id_org" FOREIGN KEY (org_id, candidate_id) REFERENCES "public"."candidates"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_messages_candidate_id_org'
             AND conrelid = to_regclass('public.candidate_messages') AND NOT convalidated) THEN
    ALTER TABLE "public"."candidate_messages" VALIDATE CONSTRAINT "fk_candidate_messages_candidate_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.candidate_offers') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_offers_candidate_id_org'
                     AND conrelid = to_regclass('public.candidate_offers')) THEN
    ALTER TABLE "public"."candidate_offers" ADD CONSTRAINT "fk_candidate_offers_candidate_id_org" FOREIGN KEY (org_id, candidate_id) REFERENCES "public"."candidates"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_offers_candidate_id_org'
             AND conrelid = to_regclass('public.candidate_offers') AND NOT convalidated) THEN
    ALTER TABLE "public"."candidate_offers" VALIDATE CONSTRAINT "fk_candidate_offers_candidate_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.candidate_offers') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_offers_job_posting_id_org'
                     AND conrelid = to_regclass('public.candidate_offers')) THEN
    ALTER TABLE "public"."candidate_offers" ADD CONSTRAINT "fk_candidate_offers_job_posting_id_org" FOREIGN KEY (org_id, job_posting_id) REFERENCES "public"."job_postings"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_offers_job_posting_id_org'
             AND conrelid = to_regclass('public.candidate_offers') AND NOT convalidated) THEN
    ALTER TABLE "public"."candidate_offers" VALIDATE CONSTRAINT "fk_candidate_offers_job_posting_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.candidate_reference_checks') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_reference_checks_candidate_id_org'
                     AND conrelid = to_regclass('public.candidate_reference_checks')) THEN
    ALTER TABLE "public"."candidate_reference_checks" ADD CONSTRAINT "fk_candidate_reference_checks_candidate_id_org" FOREIGN KEY (org_id, candidate_id) REFERENCES "public"."candidates"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_reference_checks_candidate_id_org'
             AND conrelid = to_regclass('public.candidate_reference_checks') AND NOT convalidated) THEN
    ALTER TABLE "public"."candidate_reference_checks" VALIDATE CONSTRAINT "fk_candidate_reference_checks_candidate_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.candidate_referrals') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_referrals_candidate_id_org'
                     AND conrelid = to_regclass('public.candidate_referrals')) THEN
    ALTER TABLE "public"."candidate_referrals" ADD CONSTRAINT "fk_candidate_referrals_candidate_id_org" FOREIGN KEY (org_id, candidate_id) REFERENCES "public"."candidates"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_referrals_candidate_id_org'
             AND conrelid = to_regclass('public.candidate_referrals') AND NOT convalidated) THEN
    ALTER TABLE "public"."candidate_referrals" VALIDATE CONSTRAINT "fk_candidate_referrals_candidate_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.candidate_referrals') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_referrals_job_posting_id_org'
                     AND conrelid = to_regclass('public.candidate_referrals')) THEN
    ALTER TABLE "public"."candidate_referrals" ADD CONSTRAINT "fk_candidate_referrals_job_posting_id_org" FOREIGN KEY (org_id, job_posting_id) REFERENCES "public"."job_postings"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_referrals_job_posting_id_org'
             AND conrelid = to_regclass('public.candidate_referrals') AND NOT convalidated) THEN
    ALTER TABLE "public"."candidate_referrals" VALIDATE CONSTRAINT "fk_candidate_referrals_job_posting_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.candidate_sla_tracking') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_sla_tracking_candidate_id_org'
                     AND conrelid = to_regclass('public.candidate_sla_tracking')) THEN
    ALTER TABLE "public"."candidate_sla_tracking" ADD CONSTRAINT "fk_candidate_sla_tracking_candidate_id_org" FOREIGN KEY (org_id, candidate_id) REFERENCES "public"."candidates"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_sla_tracking_candidate_id_org'
             AND conrelid = to_regclass('public.candidate_sla_tracking') AND NOT convalidated) THEN
    ALTER TABLE "public"."candidate_sla_tracking" VALIDATE CONSTRAINT "fk_candidate_sla_tracking_candidate_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.candidates') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidates_duplicate_of_id_org'
                     AND conrelid = to_regclass('public.candidates')) THEN
    ALTER TABLE "public"."candidates" ADD CONSTRAINT "fk_candidates_duplicate_of_id_org" FOREIGN KEY (org_id, duplicate_of_id) REFERENCES "public"."candidates"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidates_duplicate_of_id_org'
             AND conrelid = to_regclass('public.candidates') AND NOT convalidated) THEN
    ALTER TABLE "public"."candidates" VALIDATE CONSTRAINT "fk_candidates_duplicate_of_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.goals') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_goals_parent_goal_id_org'
                     AND conrelid = to_regclass('public.goals')) THEN
    ALTER TABLE "public"."goals" ADD CONSTRAINT "fk_goals_parent_goal_id_org" FOREIGN KEY (org_id, parent_goal_id) REFERENCES "public"."goals"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_goals_parent_goal_id_org'
             AND conrelid = to_regclass('public.goals') AND NOT convalidated) THEN
    ALTER TABLE "public"."goals" VALIDATE CONSTRAINT "fk_goals_parent_goal_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hiring_flow_rounds') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hiring_flow_rounds_flow_id_org'
                     AND conrelid = to_regclass('public.hiring_flow_rounds')) THEN
    ALTER TABLE "public"."hiring_flow_rounds" ADD CONSTRAINT "fk_hiring_flow_rounds_flow_id_org" FOREIGN KEY (org_id, flow_id) REFERENCES "public"."hiring_flows"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hiring_flow_rounds_flow_id_org'
             AND conrelid = to_regclass('public.hiring_flow_rounds') AND NOT convalidated) THEN
    ALTER TABLE "public"."hiring_flow_rounds" VALIDATE CONSTRAINT "fk_hiring_flow_rounds_flow_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hiring_flow_rounds') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hiring_flow_rounds_scorecard_template_id_org'
                     AND conrelid = to_regclass('public.hiring_flow_rounds')) THEN
    ALTER TABLE "public"."hiring_flow_rounds" ADD CONSTRAINT "fk_hiring_flow_rounds_scorecard_template_id_org" FOREIGN KEY (org_id, scorecard_template_id) REFERENCES "public"."scorecard_templates"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hiring_flow_rounds_scorecard_template_id_org'
             AND conrelid = to_regclass('public.hiring_flow_rounds') AND NOT convalidated) THEN
    ALTER TABLE "public"."hiring_flow_rounds" VALIDATE CONSTRAINT "fk_hiring_flow_rounds_scorecard_template_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.interview_booking_links') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_interview_booking_links_candidate_id_org'
                     AND conrelid = to_regclass('public.interview_booking_links')) THEN
    ALTER TABLE "public"."interview_booking_links" ADD CONSTRAINT "fk_interview_booking_links_candidate_id_org" FOREIGN KEY (org_id, candidate_id) REFERENCES "public"."candidates"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_interview_booking_links_candidate_id_org'
             AND conrelid = to_regclass('public.interview_booking_links') AND NOT convalidated) THEN
    ALTER TABLE "public"."interview_booking_links" VALIDATE CONSTRAINT "fk_interview_booking_links_candidate_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.interview_booking_links') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_interview_booking_links_job_posting_id_org'
                     AND conrelid = to_regclass('public.interview_booking_links')) THEN
    ALTER TABLE "public"."interview_booking_links" ADD CONSTRAINT "fk_interview_booking_links_job_posting_id_org" FOREIGN KEY (org_id, job_posting_id) REFERENCES "public"."job_postings"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_interview_booking_links_job_posting_id_org'
             AND conrelid = to_regclass('public.interview_booking_links') AND NOT convalidated) THEN
    ALTER TABLE "public"."interview_booking_links" VALIDATE CONSTRAINT "fk_interview_booking_links_job_posting_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.interview_panel_members') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_interview_panel_members_interview_id_org'
                     AND conrelid = to_regclass('public.interview_panel_members')) THEN
    ALTER TABLE "public"."interview_panel_members" ADD CONSTRAINT "fk_interview_panel_members_interview_id_org" FOREIGN KEY (org_id, interview_id) REFERENCES "public"."interviews"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_interview_panel_members_interview_id_org'
             AND conrelid = to_regclass('public.interview_panel_members') AND NOT convalidated) THEN
    ALTER TABLE "public"."interview_panel_members" VALIDATE CONSTRAINT "fk_interview_panel_members_interview_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.interview_scorecards') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_interview_scorecards_interview_id_org'
                     AND conrelid = to_regclass('public.interview_scorecards')) THEN
    ALTER TABLE "public"."interview_scorecards" ADD CONSTRAINT "fk_interview_scorecards_interview_id_org" FOREIGN KEY (org_id, interview_id) REFERENCES "public"."interviews"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_interview_scorecards_interview_id_org'
             AND conrelid = to_regclass('public.interview_scorecards') AND NOT convalidated) THEN
    ALTER TABLE "public"."interview_scorecards" VALIDATE CONSTRAINT "fk_interview_scorecards_interview_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.interview_scorecards') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_interview_scorecards_template_id_org'
                     AND conrelid = to_regclass('public.interview_scorecards')) THEN
    ALTER TABLE "public"."interview_scorecards" ADD CONSTRAINT "fk_interview_scorecards_template_id_org" FOREIGN KEY (org_id, template_id) REFERENCES "public"."scorecard_templates"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_interview_scorecards_template_id_org'
             AND conrelid = to_regclass('public.interview_scorecards') AND NOT convalidated) THEN
    ALTER TABLE "public"."interview_scorecards" VALIDATE CONSTRAINT "fk_interview_scorecards_template_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.interviews') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_interviews_candidate_id_org'
                     AND conrelid = to_regclass('public.interviews')) THEN
    ALTER TABLE "public"."interviews" ADD CONSTRAINT "fk_interviews_candidate_id_org" FOREIGN KEY (org_id, candidate_id) REFERENCES "public"."candidates"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_interviews_candidate_id_org'
             AND conrelid = to_regclass('public.interviews') AND NOT convalidated) THEN
    ALTER TABLE "public"."interviews" VALIDATE CONSTRAINT "fk_interviews_candidate_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.interviews') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_interviews_job_posting_id_org'
                     AND conrelid = to_regclass('public.interviews')) THEN
    ALTER TABLE "public"."interviews" ADD CONSTRAINT "fk_interviews_job_posting_id_org" FOREIGN KEY (org_id, job_posting_id) REFERENCES "public"."job_postings"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_interviews_job_posting_id_org'
             AND conrelid = to_regclass('public.interviews') AND NOT convalidated) THEN
    ALTER TABLE "public"."interviews" VALIDATE CONSTRAINT "fk_interviews_job_posting_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.job_board_postings') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_job_board_postings_job_posting_id_org'
                     AND conrelid = to_regclass('public.job_board_postings')) THEN
    ALTER TABLE "public"."job_board_postings" ADD CONSTRAINT "fk_job_board_postings_job_posting_id_org" FOREIGN KEY (org_id, job_posting_id) REFERENCES "public"."job_postings"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_job_board_postings_job_posting_id_org'
             AND conrelid = to_regclass('public.job_board_postings') AND NOT convalidated) THEN
    ALTER TABLE "public"."job_board_postings" VALIDATE CONSTRAINT "fk_job_board_postings_job_posting_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.job_postings') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_job_postings_hiring_flow_id_org'
                     AND conrelid = to_regclass('public.job_postings')) THEN
    ALTER TABLE "public"."job_postings" ADD CONSTRAINT "fk_job_postings_hiring_flow_id_org" FOREIGN KEY (org_id, hiring_flow_id) REFERENCES "public"."hiring_flows"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_job_postings_hiring_flow_id_org'
             AND conrelid = to_regclass('public.job_postings') AND NOT convalidated) THEN
    ALTER TABLE "public"."job_postings" VALIDATE CONSTRAINT "fk_job_postings_hiring_flow_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.job_recruiters') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_job_recruiters_job_posting_id_org'
                     AND conrelid = to_regclass('public.job_recruiters')) THEN
    ALTER TABLE "public"."job_recruiters" ADD CONSTRAINT "fk_job_recruiters_job_posting_id_org" FOREIGN KEY (org_id, job_posting_id) REFERENCES "public"."job_postings"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_job_recruiters_job_posting_id_org'
             AND conrelid = to_regclass('public.job_recruiters') AND NOT convalidated) THEN
    ALTER TABLE "public"."job_recruiters" VALIDATE CONSTRAINT "fk_job_recruiters_job_posting_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.offer_negotiations') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_offer_negotiations_offer_id_org'
                     AND conrelid = to_regclass('public.offer_negotiations')) THEN
    ALTER TABLE "public"."offer_negotiations" ADD CONSTRAINT "fk_offer_negotiations_offer_id_org" FOREIGN KEY (org_id, offer_id) REFERENCES "public"."candidate_offers"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_offer_negotiations_offer_id_org'
             AND conrelid = to_regclass('public.offer_negotiations') AND NOT convalidated) THEN
    ALTER TABLE "public"."offer_negotiations" VALIDATE CONSTRAINT "fk_offer_negotiations_offer_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.offer_versions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_offer_versions_offer_id_org'
                     AND conrelid = to_regclass('public.offer_versions')) THEN
    ALTER TABLE "public"."offer_versions" ADD CONSTRAINT "fk_offer_versions_offer_id_org" FOREIGN KEY (org_id, offer_id) REFERENCES "public"."candidate_offers"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_offer_versions_offer_id_org'
             AND conrelid = to_regclass('public.offer_versions') AND NOT convalidated) THEN
    ALTER TABLE "public"."offer_versions" VALIDATE CONSTRAINT "fk_offer_versions_offer_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.performance_reviews') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_performance_reviews_cycle_id_org'
                     AND conrelid = to_regclass('public.performance_reviews')) THEN
    ALTER TABLE "public"."performance_reviews" ADD CONSTRAINT "fk_performance_reviews_cycle_id_org" FOREIGN KEY (org_id, cycle_id) REFERENCES "public"."review_cycles"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_performance_reviews_cycle_id_org'
             AND conrelid = to_regclass('public.performance_reviews') AND NOT convalidated) THEN
    ALTER TABLE "public"."performance_reviews" VALIDATE CONSTRAINT "fk_performance_reviews_cycle_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.recruiter_activity_log') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_recruiter_activity_log_candidate_id_org'
                     AND conrelid = to_regclass('public.recruiter_activity_log')) THEN
    ALTER TABLE "public"."recruiter_activity_log" ADD CONSTRAINT "fk_recruiter_activity_log_candidate_id_org" FOREIGN KEY (org_id, candidate_id) REFERENCES "public"."candidates"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_recruiter_activity_log_candidate_id_org'
             AND conrelid = to_regclass('public.recruiter_activity_log') AND NOT convalidated) THEN
    ALTER TABLE "public"."recruiter_activity_log" VALIDATE CONSTRAINT "fk_recruiter_activity_log_candidate_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.recruiter_activity_log') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_recruiter_activity_log_job_posting_id_org'
                     AND conrelid = to_regclass('public.recruiter_activity_log')) THEN
    ALTER TABLE "public"."recruiter_activity_log" ADD CONSTRAINT "fk_recruiter_activity_log_job_posting_id_org" FOREIGN KEY (org_id, job_posting_id) REFERENCES "public"."job_postings"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_recruiter_activity_log_job_posting_id_org'
             AND conrelid = to_regclass('public.recruiter_activity_log') AND NOT convalidated) THEN
    ALTER TABLE "public"."recruiter_activity_log" VALIDATE CONSTRAINT "fk_recruiter_activity_log_job_posting_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.review_cycles') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_review_cycles_template_id_org'
                     AND conrelid = to_regclass('public.review_cycles')) THEN
    ALTER TABLE "public"."review_cycles" ADD CONSTRAINT "fk_review_cycles_template_id_org" FOREIGN KEY (org_id, template_id) REFERENCES "public"."hr_templates"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_review_cycles_template_id_org'
             AND conrelid = to_regclass('public.review_cycles') AND NOT convalidated) THEN
    ALTER TABLE "public"."review_cycles" VALIDATE CONSTRAINT "fk_review_cycles_template_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.talent_pool_members') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_talent_pool_members_candidate_id_org'
                     AND conrelid = to_regclass('public.talent_pool_members')) THEN
    ALTER TABLE "public"."talent_pool_members" ADD CONSTRAINT "fk_talent_pool_members_candidate_id_org" FOREIGN KEY (org_id, candidate_id) REFERENCES "public"."candidates"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_talent_pool_members_candidate_id_org'
             AND conrelid = to_regclass('public.talent_pool_members') AND NOT convalidated) THEN
    ALTER TABLE "public"."talent_pool_members" VALIDATE CONSTRAINT "fk_talent_pool_members_candidate_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.talent_pool_members') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_talent_pool_members_pool_id_org'
                     AND conrelid = to_regclass('public.talent_pool_members')) THEN
    ALTER TABLE "public"."talent_pool_members" ADD CONSTRAINT "fk_talent_pool_members_pool_id_org" FOREIGN KEY (org_id, pool_id) REFERENCES "public"."talent_pools"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_talent_pool_members_pool_id_org'
             AND conrelid = to_regclass('public.talent_pool_members') AND NOT convalidated) THEN
    ALTER TABLE "public"."talent_pool_members" VALIDATE CONSTRAINT "fk_talent_pool_members_pool_id_org";
  END IF;
END $$;
