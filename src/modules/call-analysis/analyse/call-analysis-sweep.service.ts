import { Inject, Injectable } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.types";
import { forEachOrg } from "../../../common/tenant";
import { startRun } from "../../../common/workflow/workflow-store";
import { CALL_ANALYSIS_WORKFLOW } from "./call-analysis.workflow";

/**
 * The scheduled entry point: one durable run per organisation, per tick.
 *
 * It starts runs and does nothing else. The work is in the workflow, so a
 * failure while sweeping thirty tenants costs the thirty-first nothing and a
 * pod restart mid-sweep resumes each organisation where it stopped rather than
 * re-reading everything it had already paid for.
 *
 * `startRun` is called with a `causationEventId` that names the organisation and
 * the hour, which is what makes the schedule idempotent: a cron that fires
 * twice, or a retry of the HTTP call that drives it, resumes the run already in
 * flight rather than starting a second pass over the same calls. Without it, two
 * ticks a minute apart would each pay for the same fifty transcripts.
 */
@Injectable()
export class CallAnalysisSweepService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * `runs` counts the runs in flight for this hour, not the ones this call
   * created. `startRun` returns the existing run on a conflict and there is no
   * way to tell the two apart from its return, which is the right trade — the
   * caller wants to know that every organisation has a pass, not which tick
   * happened to open it.
   */
  async sweep(now: Date = new Date()): Promise<{ organizations: number; runs: number }> {
    const hourKey = now.toISOString().slice(0, 13);
    let runs = 0;

    const result = await forEachOrg(this.db, "call-analysis", async (_tx, orgId) => {
      const runId = await startRun(this.db, {
        organizationId: orgId,
        workflowName: CALL_ANALYSIS_WORKFLOW,
        input: {},
        causationEventId: `call-analysis:${orgId}:${hourKey}`,
        correlationId: `call-analysis:${hourKey}`,
      });
      if (runId) runs += 1;
    });

    return { organizations: result.organizations, runs };
  }
}
