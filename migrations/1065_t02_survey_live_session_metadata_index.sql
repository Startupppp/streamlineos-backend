-- 1065 — index the one JSONB property this repo authorises and joins on.
--
-- PRD-C058: "Frequently filtered, joined, authorized or constrained JSONB properties must
-- be normalized or indexed rather than silently retained as opaque payload."
-- `survey_response_sessions.metadata->>'liveSessionId'` is the whole link between a live
-- session and its participants. It is read on three paths:
--
--   * SurveyLiveParticipantService.getParticipantCount  — every poll of the host screen
--   * SurveyLiveParticipantService.getQuestionResults   — every poll of the host screen
--   * getResponseSessionForToken                        — every participant answer
--
-- and the table carried four indexes, none of them touching metadata: the primary key,
-- (org_id, survey_id, submitted_at), (collector_id) and the (org_id, id) tenant-anchored
-- unique. So both host-screen reads were a full scan of the tenant's entire
-- survey_response_sessions table with a per-row JSON parse, on a route the host polls
-- while an audience answers.
--
-- Measured on scratch_gates_head (685/685 journal entries) with 40,000 synthetic sessions
-- in one organisation across 100 live sessions of 400 participants each, ANALYZEd, the
-- whole fixture inside a transaction that rolled back:
--
--   before   Aggregate -> Seq Scan on survey_response_sessions
--            Filter: ((org_id = ...) AND ((metadata ->> 'liveSessionId') = '7'))
--            Rows Removed by Filter: 39600
--            Buffers: shared hit=690         Execution Time 2.998 ms
--
--   after    Aggregate -> Index Scan using idx_survey_response_sessions_org_live_session
--            Index Cond: ((org_id = ...) AND ((metadata ->> 'liveSessionId') = '7'))
--            Buffers: shared hit=400 read=2  Execution Time 0.233 ms
--
-- 12.9x on execution time at this size. The number that matters is not the ratio but the
-- shape: the pre-index plan reads EVERY session row in the organisation and parses its
-- JSON, so it is O(tenant survey history) while the index scan is O(participants in this
-- live session). At 40,000 rows it removes 39,600 by filter; the host screen polls it.
--
-- LEADING WITH org_id, not with the expression. Every reader is tenant-scoped and the
-- expression alone would put two organisations' live sessions in one index range; leading
-- with the tenant column keeps the scan inside one tenant and matches the leading-column
-- rule the rest of this schema follows.
--
-- NOT NORMALISED HERE, deliberately. Moving liveSessionId to a real column is the better
-- end state and PRD-C058 names it; it needs a backfill, a dual-write release and a change
-- to the join shape in three services, which is a larger change than this release's
-- surveys scope. The index is the part that removes the measured cost, and the column
-- remains recorded as a REFACTOR entry in the PRD-C057 inventory
-- (database.jsonb-key, item `metadata->>'liveSessionId'`) so it is not lost.
--
-- LOCKING. drizzle-kit migrate wraps the file in one transaction, so CONCURRENTLY is not
-- available; lock_timeout is set below and the build takes ACCESS EXCLUSIVE on
-- survey_response_sessions for its duration. If it fails the whole file rolls back.

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_survey_response_sessions_org_live_session"
  ON "survey_response_sessions" ("org_id", (("metadata"->>'liveSessionId')));
--> statement-breakpoint

-- Read the catalog back rather than trusting completion: db:migrate reports success over a
-- statement that did nothing, and IF NOT EXISTS hides a no-op.
DO $$
DECLARE
  definition text;
BEGIN
  SELECT pg_get_indexdef(x.indexrelid) INTO definition
    FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
   WHERE i.relname = 'idx_survey_response_sessions_org_live_session'
     AND x.indrelid = 'survey_response_sessions'::regclass;
  IF NOT FOUND THEN
    RAISE EXCEPTION '1065: idx_survey_response_sessions_org_live_session was not created';
  END IF;
  IF definition NOT LIKE '%liveSessionId%' THEN
    RAISE EXCEPTION '1065: the index exists but does not cover the liveSessionId expression (%)', definition;
  END IF;
  IF definition NOT LIKE '%org_id%' THEN
    RAISE EXCEPTION '1065: the index does not lead with org_id, so it spans tenants (%)', definition;
  END IF;
END
$$;
