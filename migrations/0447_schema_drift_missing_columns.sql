SET lock_timeout = '5s';

-- The Drizzle schema is the source of truth and had drifted ahead of the database
-- on ten tables: the canonical person model (organization_people, workers,
-- worker_engagements, hr_people, hr_employments), the org hierarchy, onboarding and
-- the exit tables. Every read that projects a whole row — db.query.*.findFirst, a
-- bare select() — died 42703 against them, which is how GET /me/attendance/status
-- and the leave-request list were found down. Additive and nullable, except
-- row_version and updated_at which carry defaults.


-- public.org_units (rows=71)
ALTER TABLE "org_units"
  ADD COLUMN IF NOT EXISTS "row_version" integer DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "archived_by_membership_id" integer,
  ADD COLUMN IF NOT EXISTS "updated_by_membership_id" integer;

--> statement-breakpoint
-- public.hr_employments (rows=0)
ALTER TABLE "hr_employments"
  ADD COLUMN IF NOT EXISTS "worker_id" text,
  ADD COLUMN IF NOT EXISTS "worker_engagement_id" text,
  ADD COLUMN IF NOT EXISTS "row_version" integer DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "archived_by_membership_id" integer,
  ADD COLUMN IF NOT EXISTS "updated_by_membership_id" integer;

--> statement-breakpoint
-- public.hr_people (rows=0)
ALTER TABLE "hr_people"
  ADD COLUMN IF NOT EXISTS "organization_person_id" text,
  ADD COLUMN IF NOT EXISTS "row_version" integer DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "archived_by_membership_id" integer,
  ADD COLUMN IF NOT EXISTS "updated_by_membership_id" integer;

--> statement-breakpoint
-- public.onboarding_documents (rows=0)
ALTER TABLE "onboarding_documents"
  ADD COLUMN IF NOT EXISTS "row_version" integer DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "updated_by_membership_id" integer;

--> statement-breakpoint
-- public.onboarding_tasks (rows=0)
ALTER TABLE "onboarding_tasks"
  ADD COLUMN IF NOT EXISTS "row_version" integer DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "created_by_membership_id" integer,
  ADD COLUMN IF NOT EXISTS "updated_by_membership_id" integer,
  ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;

--> statement-breakpoint
-- public.resignations (rows=0)
ALTER TABLE "resignations"
  ADD COLUMN IF NOT EXISTS "row_version" integer DEFAULT 1 NOT NULL;

--> statement-breakpoint
-- public.terminations (rows=0)
ALTER TABLE "terminations"
  ADD COLUMN IF NOT EXISTS "row_version" integer DEFAULT 1 NOT NULL;

--> statement-breakpoint
-- public.organization_people (rows=3)
ALTER TABLE "organization_people"
  ADD COLUMN IF NOT EXISTS "row_version" integer DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "archived_by_membership_id" integer,
  ADD COLUMN IF NOT EXISTS "updated_by_membership_id" integer;

--> statement-breakpoint
-- public.workers (rows=1)
ALTER TABLE "workers"
  ADD COLUMN IF NOT EXISTS "row_version" integer DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "created_by_membership_id" integer,
  ADD COLUMN IF NOT EXISTS "updated_by_membership_id" integer,
  ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "archived_by_membership_id" integer;

--> statement-breakpoint
-- public.worker_engagements (rows=2)
ALTER TABLE "worker_engagements"
  ADD COLUMN IF NOT EXISTS "state_reason" text,
  ADD COLUMN IF NOT EXISTS "last_state_event_id" bigint,
  ADD COLUMN IF NOT EXISTS "row_version" integer DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "created_by_membership_id" integer,
  ADD COLUMN IF NOT EXISTS "updated_by_membership_id" integer,
  ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "archived_by_membership_id" integer;
