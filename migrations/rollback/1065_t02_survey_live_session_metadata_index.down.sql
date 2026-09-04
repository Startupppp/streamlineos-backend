-- 1065 DOWN — drops the live-session metadata index.
--
-- @reopens-a-defect: both host-screen reads (SurveyLiveParticipantService.getParticipantCount
-- and .getQuestionResults) go back to a sequential scan of the tenant's entire
-- survey_response_sessions table with a per-row JSON parse, on a route the host polls while
-- an audience answers. Measured on 40,000 sessions in one organisation: 0.233 ms /
-- 402 buffers becomes 2.998 ms / 690 buffers with 39,600 rows removed by filter, and the
-- cost grows with the organisation's whole survey history rather than with the live
-- session.
--
-- Nothing else is reversed: the index carries no uniqueness, no constraint depends on it,
-- and no row is written or deleted in either direction. Remove the declaration at
-- src/db/schema/surveys/responses.ts in the same change, or check:declaration-constraint-drift
-- will report a declared index that does not exist.

SET lock_timeout = '5s';
--> statement-breakpoint

DROP INDEX IF EXISTS "idx_survey_response_sessions_org_live_session";
