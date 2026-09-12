import { and, desc, eq, gte, isNull } from "drizzle-orm";
import { keysetAtOrBefore } from "../../../common/pagination/keyset";
import type { Db } from "../../../db/drizzle.types";
import { activities, activityParticipants, crmPipelineStages } from "../../../db/schema";
import { THREAD_WINDOW_MAX_MESSAGES, windowStart, type ThreadActivity } from "../thread-window";

/*
  The three reads `AutonomyService.processActivity` makes of the tenant's CRM:
  the message and who sent it, the messages around it on its thread, and the
  stage keys a decision may name.
*/

/**
 * Hard caps, so a long thread cannot become an unbounded context window.
 *
 * The conversation's cap lives in `thread-window.ts` now, with the two bounds it
 * has to be read alongside — a character budget stated apart from the count and
 * time bounds it shares a window with is a number nobody can check.
 */
const MAX_STAGES = 40;

/**
 * The activity, and who sent it.
 *
 * The sender lives on `activity_participants`, not on the activity, so reading
 * the activity alone leaves `classifyDelivery` with an empty `fromAddress` and
 * only its subject-phrase check alive — which is how a bounce from
 * `mailer-daemon@` was read as a customer replying. Joined rather than fetched
 * separately: it is one row either way, and this is on the path of every
 * inbound message.
 */
export async function loadAutonomyActivity(db: Db, organizationId: string, activityId: string) {
  const [row] = await db
    .select({
      // The window needs the same shape a neighbour has, so the message being
      // judged goes through the same rules as everything read beside it.
      activityId: activities.activityId,
      kind: activities.kind,
      occurredAt: activities.occurredAt,
      threadId: activities.threadId,
      actorKind: activities.actorKind,
      source: activities.source,
      subject: activities.subject,
      body: activities.body,
      partyId: activities.partyId,
      dealId: activities.dealId,
      fromAddress: activityParticipants.address,
    })
    .from(activities)
    .leftJoin(
      activityParticipants,
      and(
        eq(activityParticipants.organizationId, activities.organizationId),
        eq(activityParticipants.activityId, activities.activityId),
        eq(activityParticipants.role, "from"),
      ),
    )
    .where(
      and(
        eq(activities.organizationId, organizationId),
        eq(activities.activityId, activityId),
        isNull(activities.deletedAt),
      ),
    )
    .limit(1);

  return row ?? null;
}

/**
 * The last few things on this message's thread, and nothing older.
 *
 * The bounds are applied twice on purpose. Here, so the read itself is small:
 * `idx_activities_thread_window` is ordered `(organization_id, thread_id,
 * occurred_at desc, activity_id desc)`, so this is a range scan that stops
 * after ten rows instead of fetching a whole thread and sorting it — and on a
 * channel that threads on a pair of phone numbers forever, a whole thread is
 * every message ever exchanged with that customer. And again in
 * `buildThreadWindow`, which is the authority: the bounds are decided by a
 * pure function that can be argued with, not by a query plan.
 *
 * The upper bound is a row comparison rather than a timestamp one because
 * timestamps collide — an imported mail folder writes hundreds in the same
 * second — and "before this message" has to mean something then too.
 */
export async function loadAutonomyThread(
  db: Db,
  organizationId: string,
  trigger: { activityId: string; threadId: string | null; occurredAt: Date },
): Promise<ThreadActivity[]> {
  // A message the seam could not thread has no neighbours by definition, and
  // asking for them would scan every unthreaded activity in the organisation.
  if (!trigger.threadId) return [];

  const rows = await db
    .select({
      activityId: activities.activityId,
      kind: activities.kind,
      subject: activities.subject,
      body: activities.body,
      occurredAt: activities.occurredAt,
      actorKind: activities.actorKind,
      source: activities.source,
    })
    .from(activities)
    .where(
      and(
        eq(activities.organizationId, organizationId),
        eq(activities.threadId, trigger.threadId),
        gte(activities.occurredAt, windowStart(trigger.occurredAt)),
        /**
         * Bound through the columns, not interpolated.
         *
         * Written inline this was `<= (${trigger.occurredAt}, …)`, which hands
         * postgres-js a bare `Date` it cannot serialise — valid SQL, clean
         * typecheck, and a throw on every threaded message the moment a real
         * connection is involved. Because it sits inside `extract-and-act`,
         * the failure was not confined to autonomy: the step threw, the run
         * retried to exhaustion, `mark-processed` never ran, and an accepted
         * inbound delivery was never filed.
         */
        keysetAtOrBefore(activities.occurredAt, activities.activityId, {
          sortValue: trigger.occurredAt,
          id: trigger.activityId,
        }),
        isNull(activities.deletedAt),
      ),
    )
    .orderBy(desc(activities.occurredAt), desc(activities.activityId))
    .limit(THREAD_WINDOW_MAX_MESSAGES);

  return rows;
}

/** The tenant's own stage keys — the only ones a decision may name. */
export async function loadAutonomyStages(
  db: Db,
  organizationId: string,
  pipelineId: string | null,
): Promise<string[]> {
  if (!pipelineId) return [];

  const rows = await db
    .select({ key: crmPipelineStages.key })
    .from(crmPipelineStages)
    .where(
      and(
        eq(crmPipelineStages.orgId, organizationId),
        eq(crmPipelineStages.pipelineId, pipelineId),
        eq(crmPipelineStages.isActive, true),
      ),
    )
    .limit(MAX_STAGES);

  return rows.map((row) => row.key);
}
