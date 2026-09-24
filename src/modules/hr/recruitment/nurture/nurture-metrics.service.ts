import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import {
  candidateMessages,
  emailSequenceEnrollments,
  emailSequences,
} from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { ENROLLMENT_STATUSES, type EnrollmentStatus } from "./nurture-stop-conditions";

export interface NurtureMetrics {
  sequenceId: number;
  enrolled: number;
  /** Steps actually delivered, across every enrollment. */
  sent: number;
  /** Enrollments whose candidate wrote in after being enrolled. */
  replied: number;
  /** Enrollments that ended because the candidate applied. */
  converted: number;
  /** Every status with a count, so a recruiter can see where a campaign stalled. */
  byStatus: Record<EnrollmentStatus, number>;
}

function emptyByStatus(): Record<EnrollmentStatus, number> {
  const zeroed = {} as Record<EnrollmentStatus, number>;
  for (const status of ENROLLMENT_STATUSES) zeroed[status] = 0;
  return zeroed;
}

@Injectable()
export class NurtureMetricsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async forSequence(orgId: string, sequenceId: number): Promise<NurtureMetrics> {
    const sequence = await this.db.query.emailSequences.findFirst({
      where: and(eq(emailSequences.id, sequenceId), eq(emailSequences.orgId, orgId)),
      columns: { id: true },
    });
    // 404 rather than an empty metric set: a sequence in another tenant and a
    // sequence with no enrollments must not look the same from outside.
    if (!sequence) throw new NotFoundException("Sequence not found");

    /*
      One pass over this sequence's enrollments.

      `sum(current_step)` is the send count, and it is exact rather than an
      approximation: the worker advances that column only after a send
      succeeded, and never moves it backwards. Counting `candidate_messages`
      instead would need a prefix match on an unindexed text column, and would
      also count a step recorded for an enrollment that has since been deleted.

      `replied` is a correlated EXISTS rather than a count of the
      `STOPPED_REPLIED` status, because a candidate can answer after the
      campaign has already completed — that reply is still the campaign's
      result, and reading it off the status would lose it.
    */
    const [row] = await this.db
      .select({
        enrolled: sql<number>`count(*)::int`,
        sent: sql<number>`coalesce(sum(${emailSequenceEnrollments.currentStep}), 0)::int`,
        converted: sql<number>`count(*) filter (where ${emailSequenceEnrollments.status} = 'STOPPED_APPLIED')::int`,
        replied: sql<number>`count(*) filter (where exists (
          select 1 from ${candidateMessages}
          where ${candidateMessages.orgId} = ${emailSequenceEnrollments.orgId}
            and ${candidateMessages.candidateId} = ${emailSequenceEnrollments.candidateId}
            and ${candidateMessages.direction} = 'INBOUND'
            and ${candidateMessages.sentAt} > ${emailSequenceEnrollments.enrolledAt}
        ))::int`,
      })
      .from(emailSequenceEnrollments)
      .where(
        and(
          eq(emailSequenceEnrollments.orgId, orgId),
          eq(emailSequenceEnrollments.sequenceId, sequenceId),
        ),
      );

    const statusRows = await this.db
      .select({
        status: emailSequenceEnrollments.status,
        total: sql<number>`count(*)::int`,
      })
      .from(emailSequenceEnrollments)
      .where(
        and(
          eq(emailSequenceEnrollments.orgId, orgId),
          eq(emailSequenceEnrollments.sequenceId, sequenceId),
        ),
      )
      .groupBy(emailSequenceEnrollments.status);

    const byStatus = emptyByStatus();
    for (const statusRow of statusRows) {
      /*
        A status the database holds but this build does not know about is
        dropped rather than added to the map. The map's type is the contract the
        frontend parses, and inventing a key for a value written by a future
        deploy would fail the parse on the client instead of here — where the
        totals above still add up and the screen still renders.
      */
      if (statusRow.status in byStatus) byStatus[statusRow.status] = statusRow.total;
    }

    return {
      sequenceId,
      enrolled: row?.enrolled ?? 0,
      sent: row?.sent ?? 0,
      replied: row?.replied ?? 0,
      converted: row?.converted ?? 0,
      byStatus,
    };
  }
}
