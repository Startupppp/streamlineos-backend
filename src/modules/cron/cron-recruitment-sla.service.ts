import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { candidateSlaTracking, interviewSlas } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { forEachOrg } from "../../common/tenant";

/**
 * Moves a candidate's stage clock from `ON_TRACK` to `AT_RISK` and then
 * `BREACHED`.
 *
 * `candidate_sla_tracking` rows are born `ON_TRACK` when `moveStage` writes
 * them, `interview_slas` stores `max_hours` and `warning_hours` per stage, and
 * nothing ever compared the two. The SLA report and the chip on every kanban
 * card therefore said `ON_TRACK` for a candidate who had been sitting in
 * Screening for a fortnight — a dashboard that can only ever be green.
 *
 * Per-org rather than one global statement: `interview_slas` is configured per
 * organisation, so the thresholds differ, and `forEachOrg` is what gives each
 * one its tenant GUC.
 */

const STATUS_ON_TRACK = "ON_TRACK";
const STATUS_AT_RISK = "AT_RISK";
const STATUS_BREACHED = "BREACHED";

/** Stages whose clock is meaningful. A hired or rejected candidate is not waiting. */
const CLOCKED_STAGES = ["NEW", "SCREENING", "INTERVIEW", "OFFER"] as const;

export interface SlaSweepOutcome {
  breached: number;
  atRisk: number;
  organizationsWithConfig: number;
}

@Injectable()
export class CronRecruitmentSlaService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async sweepStageSlas(): Promise<SlaSweepOutcome> {
    const outcome: SlaSweepOutcome = { breached: 0, atRisk: 0, organizationsWithConfig: 0 };

    await forEachOrg(this.db, "recruitment-sla-sweep", async (tx, orgId) => {
      const configured = await tx
        .select({
          stage: interviewSlas.stage,
          maxHours: interviewSlas.maxHours,
          warningHours: interviewSlas.warningHours,
        })
        .from(interviewSlas)
        .where(eq(interviewSlas.orgId, orgId))
        .limit(100);
      if (configured.length === 0) return;
      outcome.organizationsWithConfig += 1;

      for (const sla of configured) {
        if (!(CLOCKED_STAGES as readonly string[]).includes(sla.stage)) continue;

        /**
         * Breach first, then at-risk: a row that is past `max_hours` is also
         * past `warning_hours`, and running the warning pass second would only
         * match rows still `ON_TRACK`, so the order cannot demote a breach.
         */
        const breached = await tx
          .update(candidateSlaTracking)
          .set({ status: STATUS_BREACHED, breachedAt: sql`now()`, updatedAt: sql`now()` })
          .where(
            and(
              eq(candidateSlaTracking.orgId, orgId),
              eq(candidateSlaTracking.stage, sla.stage),
              inArray(candidateSlaTracking.status, [STATUS_ON_TRACK, STATUS_AT_RISK]),
              sql`${candidateSlaTracking.enteredAt} < now() - (${sla.maxHours} || ' hours')::interval`,
            ),
          )
          .returning({ id: candidateSlaTracking.id });
        outcome.breached += breached.length;

        const atRisk = await tx
          .update(candidateSlaTracking)
          .set({ status: STATUS_AT_RISK, updatedAt: sql`now()` })
          .where(
            and(
              eq(candidateSlaTracking.orgId, orgId),
              eq(candidateSlaTracking.stage, sla.stage),
              eq(candidateSlaTracking.status, STATUS_ON_TRACK),
              sql`${candidateSlaTracking.enteredAt} < now() - (${sla.warningHours} || ' hours')::interval`,
            ),
          )
          .returning({ id: candidateSlaTracking.id });
        outcome.atRisk += atRisk.length;
      }
    });

    return outcome;
  }
}
