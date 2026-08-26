import { and, eq } from "drizzle-orm";
import { activities } from "../../../../db/schema";
import { ANCHOR_PARTY_ID, isActivityKind } from "../import-entities";
import type { EntityWriter } from "./entity-writer";

/**
 * Landing a row as one thing that happened.
 *
 * Three constraints on `activities` shape this writer, and each is a CHECK
 * rather than a convention, so getting one wrong is a 23514 on row four
 * thousand rather than a subtly wrong timeline.
 *
 * `chk_activities_one_anchor` requires exactly one of party, deal or subject.
 * The plan resolves that anchor against this tenant and skips the rows it
 * cannot — so the preview shows them as skipped, and by the time a row reaches
 * here it has one.
 *
 * `chk_activities_actor` requires `actor_kind = 'system'` to carry no user id.
 * An imported activity IS a system record: nobody in this organisation made the
 * call, the import read it out of somebody else's export. Attributing it to the
 * person who uploaded the file would put two hundred calls they never made on
 * their name, which is exactly the lie that column exists to prevent.
 *
 * `chk_activities_task_fields` allows a due date only on a task. A due date on
 * an imported e-mail is a field nothing reads and a constraint violation, so it
 * is dropped unless the row really is a task.
 *
 * There is no update path. An activity has no unique business key — two calls
 * to the same company on the same day are two calls — so
 * `matchStrategyFor("activity")` is `none` and no `update` row can be planned.
 */

/**
 * What an activity is when the file did not say.
 *
 * A note, because a note claims the least: it records that something was
 * written down, which is true of every row in every activities export. Guessing
 * "call" or "meeting" would put an event on a timeline that may never have
 * happened in that form.
 */
const DEFAULT_KIND = "note";

export const ACTIVITY_WRITER: EntityWriter = {
  async create(tx, context, row) {
    const values = row.values;
    const partyId = values[ANCHOR_PARTY_ID];
    if (!partyId) throw new Error("an activity row with nothing to attach it to");

    const kind = isActivityKind(values.kind) ? values.kind : DEFAULT_KIND;
    const occurredAt = values.occurredAt ? new Date(values.occurredAt) : null;
    const dueAt = values.dueAt ? new Date(values.dueAt) : null;

    const [activity] = await tx
      .insert(activities)
      .values({
        organizationId: context.organizationId,
        kind,
        // `occurred_at` defaults to now, which is the honest answer for a row
        // whose date could not be read: the import is when we learned of it.
        occurredAt: occurredAt && !Number.isNaN(occurredAt.getTime()) ? occurredAt : undefined,
        subject: values.subject ?? null,
        body: values.body ?? null,
        partyId,
        actorKind: "system",
        actorLabel: "import",
        source: "import",
        dueAt: kind === "task" && dueAt && !Number.isNaN(dueAt.getTime()) ? dueAt : null,
        metadata: row.customFields ?? null,
      })
      .returning({ activityId: activities.activityId });

    if (!activity) throw new Error("insert returned no row");
    return activity.activityId;
  },

  async remove(tx, context, recordId) {
    await tx
      .update(activities)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(activities.organizationId, context.organizationId),
          eq(activities.activityId, recordId),
        ),
      );
  },
};
