DO $$ BEGIN
  CREATE TYPE "reward_point_source" AS ENUM ('kudos', 'badge', 'manual', 'redemption');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "hr_poll_status" AS ENUM ('draft', 'active', 'closed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "community_member_role" AS ENUM ('member', 'moderator');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "engagement_campaign_status" AS ENUM ('draft', 'active', 'completed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "hr_mood_checkins" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "date" text NOT NULL,
  "mood" integer NOT NULL,
  "note" text,
  "created_at" timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS "uniq_mood_org_user_date" ON "hr_mood_checkins" ("org_id", "user_id", "date");
EXCEPTION WHEN duplicate_table THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "idx_mood_checkins_org_date" ON "hr_mood_checkins" ("org_id", "date");

CREATE TABLE IF NOT EXISTS "hr_badges" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "description" text NOT NULL,
  "icon" text NOT NULL,
  "points" integer DEFAULT 10 NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS "uniq_badge_org_name" ON "hr_badges" ("org_id", "name");
EXCEPTION WHEN duplicate_table THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "idx_badges_org" ON "hr_badges" ("org_id");

CREATE TABLE IF NOT EXISTS "hr_badge_awards" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "badge_id" integer NOT NULL REFERENCES "hr_badges"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "awarded_by" text REFERENCES "users"("id") ON DELETE SET NULL,
  "reason" text,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_badge_awards_org_user" ON "hr_badge_awards" ("org_id", "user_id");
CREATE INDEX IF NOT EXISTS "idx_badge_awards_badge" ON "hr_badge_awards" ("badge_id");

CREATE TABLE IF NOT EXISTS "hr_reward_points_ledger" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "points" integer NOT NULL,
  "source" "reward_point_source" NOT NULL,
  "source_id" text,
  "note" text,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_reward_ledger_org_user" ON "hr_reward_points_ledger" ("org_id", "user_id");
CREATE INDEX IF NOT EXISTS "idx_reward_ledger_org_created" ON "hr_reward_points_ledger" ("org_id", "created_at");

CREATE TABLE IF NOT EXISTS "hr_polls" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "question" text NOT NULL,
  "options" jsonb NOT NULL,
  "status" "hr_poll_status" DEFAULT 'draft' NOT NULL,
  "anonymous" boolean DEFAULT false NOT NULL,
  "created_by" text REFERENCES "users"("id") ON DELETE SET NULL,
  "closes_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_hr_polls_org_status" ON "hr_polls" ("org_id", "status");

CREATE TABLE IF NOT EXISTS "hr_poll_votes" (
  "id" serial PRIMARY KEY NOT NULL,
  "poll_id" integer NOT NULL REFERENCES "hr_polls"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "option_index" integer NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS "uniq_poll_vote_poll_user" ON "hr_poll_votes" ("poll_id", "user_id");
EXCEPTION WHEN duplicate_table THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "idx_poll_votes_poll" ON "hr_poll_votes" ("poll_id");

CREATE TABLE IF NOT EXISTS "hr_communities" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "description" text,
  "created_by" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS "uniq_community_org_name" ON "hr_communities" ("org_id", "name");
EXCEPTION WHEN duplicate_table THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "idx_communities_org" ON "hr_communities" ("org_id");

CREATE TABLE IF NOT EXISTS "hr_community_members" (
  "id" serial PRIMARY KEY NOT NULL,
  "community_id" integer NOT NULL REFERENCES "hr_communities"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "role" "community_member_role" DEFAULT 'member' NOT NULL,
  "joined_at" timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS "uniq_community_member" ON "hr_community_members" ("community_id", "user_id");
EXCEPTION WHEN duplicate_table THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "idx_community_members_community" ON "hr_community_members" ("community_id");
CREATE INDEX IF NOT EXISTS "idx_community_members_user" ON "hr_community_members" ("user_id");

CREATE TABLE IF NOT EXISTS "hr_campaigns" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "description" text,
  "starts_at" timestamp,
  "ends_at" timestamp,
  "status" "engagement_campaign_status" DEFAULT 'draft' NOT NULL,
  "audience" jsonb,
  "created_by" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_campaigns_org_status" ON "hr_campaigns" ("org_id", "status");
