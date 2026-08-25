import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { issueRecords, issueStageTransitions, users } from "../../db/schema";
import type { IssueStage } from "../../db/schema/crm/issue-records";
import { actorColumns, canTransition, clockStamps, type StageActor } from "./issue-stage-ledger";

/**
 * Escalation, and every other stage move, as one accountable write.
 *
 * Criterion 4. The ledger this writes into is `deal_stage_transitions`' model —
 * the same discriminated actor, the same CHECK, the same reason that survives,
 * the same pair of indexes — because that ledger was built for precisely this
 * failure and reinventing it here would produce a second, subtly different
 * answer to "who did this".
 *
 * A system actor is a first-class caller of `transition`, not an afterthought.
 * An SLA sweep that escalates a complaint at 3am is a real accountable act with
 * no person behind it, and before ticket 08 the only way to record one was to
 * file it under whoever was nearest. `StageActor` makes the machine name itself
 * and 0290's CHECK refuses the row if it does not.
 *
 * No `db.transaction()` here. `this.db` is the request's ambient tenant
 * transaction, so the record update and the ledger row are already one atomic
 * unit; opening a savepoint would add a rollback point nothing needs and quietly
 * suggest the two writes could be separated. They cannot: a stage that moved
 * without a ledger row is the bug.
 */
@Injectable()
export class IssueTransitionsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * One record's history, newest first.
   *
   * The actor's name is resolved here rather than left to the caller, and by a
   * `leftJoin` rather than a foreign key: `actor_user_id` deliberately has no
   * referential edge to `users` (see 0223), so a purged actor resolves to null
   * and the surface renders an unknown actor — a strictly better failure than an
   * audit entry that was deleted along with the person.
   */
  list(organizationId: string, issueRecordId: string, limit: number) {
    return this.db
      .select({
        issueStageTransitionId: issueStageTransitions.issueStageTransitionId,
        fromStage: issueStageTransitions.fromStage,
        toStage: issueStageTransitions.toStage,
        actorKind: issueStageTransitions.actorKind,
        actorLabel: issueStageTransitions.actorLabel,
        actorUserId: issueStageTransitions.actorUserId,
        actorName: users.name,
        reason: issueStageTransitions.reason,
        occurredAt: issueStageTransitions.occurredAt,
      })
      .from(issueStageTransitions)
      .leftJoin(users, eq(users.id, issueStageTransitions.actorUserId))
      .where(
        and(
          eq(issueStageTransitions.organizationId, organizationId),
          eq(issueStageTransitions.issueRecordId, issueRecordId),
        ),
      )
      .orderBy(desc(issueStageTransitions.occurredAt))
      .limit(limit);
  }

  /**
   * The first row of a record's ledger: null → `open`.
   *
   * The same shape `deal_stage_transitions` uses for a deal's first move, where
   * `from_stage` is null because there was no prior stage. A ledger that starts
   * at the second thing that happened cannot say who raised the record.
   */
  async recordOpening(
    organizationId: string,
    issueRecordId: string,
    actor: StageActor,
  ): Promise<void> {
    await this.db.insert(issueStageTransitions).values({
      organizationId,
      issueRecordId,
      fromStage: null,
      toStage: "open",
      ...actorColumns(actor),
      reason: null,
    });
  }

  /**
   * Move a record's stage, and say who moved it.
   *
   * The record is locked for the duration. Two people resolving the same
   * complaint in the same second would otherwise both read `open`, both write,
   * and leave two ledger rows claiming to be the transition out of `open` —
   * which makes the history unreadable in exactly the case it matters.
   */
  async transition(
    organizationId: string,
    issueRecordId: string,
    toStage: IssueStage,
    actor: StageActor,
    reason: string | null,
  ) {
    const [current] = await this.db
      .select({
        stage: issueRecords.stage,
        acknowledgedAt: issueRecords.acknowledgedAt,
      })
      .from(issueRecords)
      .where(
        and(
          eq(issueRecords.organizationId, organizationId),
          eq(issueRecords.issueRecordId, issueRecordId),
        ),
      )
      .limit(1)
      .for("update");

    /** 404 for another organisation's record, never 403. See `IssuesService.read`. */
    if (!current) throw new NotFoundException("Record not found");

    if (!canTransition(current.stage, toStage))
      throw new BadRequestException(
        `A record at ${current.stage} cannot move to ${toStage}`,
      );

    const at = new Date();
    const stamps = clockStamps(toStage, at, current.acknowledgedAt);

    await this.db
      .update(issueRecords)
      .set({ stage: toStage, ...stamps })
      .where(
        and(
          eq(issueRecords.organizationId, organizationId),
          eq(issueRecords.issueRecordId, issueRecordId),
        ),
      );

    const [written] = await this.db
      .insert(issueStageTransitions)
      .values({
        organizationId,
        issueRecordId,
        fromStage: current.stage,
        toStage,
        ...actorColumns(actor),
        reason,
        occurredAt: at,
      })
      .returning({
        issueStageTransitionId: issueStageTransitions.issueStageTransitionId,
      });

    return {
      issueRecordId,
      fromStage: current.stage,
      toStage,
      issueStageTransitionId: written?.issueStageTransitionId ?? null,
    };
  }

  /**
   * Raise a record above its owner.
   *
   * Not a separate mechanism — the same `transition` write, to the stage named
   * `escalated`. That is the whole of criterion 4: escalation is a stage, its
   * record is a ledger row, and the thing that escalated it may be a machine
   * that names itself. It has its own method and its own permission key because
   * deciding somebody's handling was not good enough is a different authority
   * from working the record, not because it is a different model.
   */
  escalate(
    organizationId: string,
    issueRecordId: string,
    actor: StageActor,
    reason: string,
  ) {
    return this.transition(organizationId, issueRecordId, "escalated", actor, reason);
  }
}
