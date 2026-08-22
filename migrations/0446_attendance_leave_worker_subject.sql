SET lock_timeout = '5s';

-- The Drizzle schema gained the canonical worker subject on `attendance` and
-- `leave_requests` — plus optimistic locking and actor columns on the latter —
-- without a migration, so every read of GET /me/attendance/status and of any
-- leave-request list died 42703 "column does not exist". Both are Home surfaces
-- every member is supposed to keep, so clocking in and time off were down for
-- every organisation.
--
-- Additive and nullable; the composite tenant FKs land NOT VALID and are
-- validated separately so neither table is held under ACCESS EXCLUSIVE while a
-- scan runs.

ALTER TABLE worker_engagements
  ADD CONSTRAINT uniq_worker_engagements_org_worker_engagement
  UNIQUE (organization_id, worker_id, worker_engagement_id);
--> statement-breakpoint

ALTER TABLE attendance
  ADD COLUMN IF NOT EXISTS worker_id text,
  ADD COLUMN IF NOT EXISTS worker_engagement_id text;
--> statement-breakpoint

ALTER TABLE leave_requests
  ADD COLUMN IF NOT EXISTS worker_id text,
  ADD COLUMN IF NOT EXISTS worker_engagement_id text,
  ADD COLUMN IF NOT EXISTS row_version integer DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS created_by_membership_id integer,
  ADD COLUMN IF NOT EXISTS updated_by_membership_id integer,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now() NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_attendance_org_worker_date
  ON attendance (org_id, worker_id, date);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_attendance_org_engagement_date
  ON attendance (org_id, worker_engagement_id, date);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_leave_requests_org_worker
  ON leave_requests (org_id, worker_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_leave_requests_org_engagement
  ON leave_requests (org_id, worker_engagement_id);
--> statement-breakpoint

ALTER TABLE attendance
  ADD CONSTRAINT fk_attendance_org_worker
  FOREIGN KEY (org_id, worker_id)
  REFERENCES workers (organization_id, worker_id)
  ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint

ALTER TABLE attendance
  ADD CONSTRAINT fk_attendance_worker_engagement
  FOREIGN KEY (org_id, worker_id, worker_engagement_id)
  REFERENCES worker_engagements (organization_id, worker_id, worker_engagement_id)
  ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint

ALTER TABLE attendance
  ADD CONSTRAINT chk_attendance_canonical_subject_pair
  CHECK ((worker_id IS NULL) = (worker_engagement_id IS NULL)) NOT VALID;
--> statement-breakpoint

ALTER TABLE leave_requests
  ADD CONSTRAINT fk_leave_requests_org_worker
  FOREIGN KEY (org_id, worker_id)
  REFERENCES workers (organization_id, worker_id)
  ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint

ALTER TABLE leave_requests
  ADD CONSTRAINT fk_leave_requests_worker_engagement
  FOREIGN KEY (org_id, worker_id, worker_engagement_id)
  REFERENCES worker_engagements (organization_id, worker_id, worker_engagement_id)
  ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint

ALTER TABLE leave_requests
  ADD CONSTRAINT fk_leave_requests_created_actor
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES organization_members (org_id, id)
  ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint

ALTER TABLE leave_requests
  ADD CONSTRAINT fk_leave_requests_updated_actor
  FOREIGN KEY (org_id, updated_by_membership_id)
  REFERENCES organization_members (org_id, id)
  ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint

ALTER TABLE leave_requests
  ADD CONSTRAINT chk_leave_requests_row_version CHECK (row_version > 0) NOT VALID;
--> statement-breakpoint

ALTER TABLE leave_requests
  ADD CONSTRAINT chk_leave_requests_canonical_subject_pair
  CHECK ((worker_id IS NULL) = (worker_engagement_id IS NULL)) NOT VALID;
--> statement-breakpoint

ALTER TABLE attendance VALIDATE CONSTRAINT fk_attendance_org_worker;
--> statement-breakpoint
ALTER TABLE attendance VALIDATE CONSTRAINT fk_attendance_worker_engagement;
--> statement-breakpoint
ALTER TABLE attendance VALIDATE CONSTRAINT chk_attendance_canonical_subject_pair;
--> statement-breakpoint
ALTER TABLE leave_requests VALIDATE CONSTRAINT fk_leave_requests_org_worker;
--> statement-breakpoint
ALTER TABLE leave_requests VALIDATE CONSTRAINT fk_leave_requests_worker_engagement;
--> statement-breakpoint
ALTER TABLE leave_requests VALIDATE CONSTRAINT fk_leave_requests_created_actor;
--> statement-breakpoint
ALTER TABLE leave_requests VALIDATE CONSTRAINT fk_leave_requests_updated_actor;
--> statement-breakpoint
ALTER TABLE leave_requests VALIDATE CONSTRAINT chk_leave_requests_row_version;
--> statement-breakpoint
ALTER TABLE leave_requests VALIDATE CONSTRAINT chk_leave_requests_canonical_subject_pair;
