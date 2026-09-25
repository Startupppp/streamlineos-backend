import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { aiJobs } from "../../../db/schema";
import type { AiJob } from "../../../db/schema";
import { and, eq } from "drizzle-orm";
import { AiJobsService } from "./ai-jobs.service";
import { AiJobHandlerRegistry, AI_JOB_HANDLERS, type AiJobHandler } from "./ai-job-handler";
import { AiJobsFairClaimer, FAIR_CLAIM_DEFAULT_PER_ORG_LIMIT } from "./ai-jobs-fair-claimer";
import { poolAdmission } from "../../../db/pool-admission";

export interface FlushResult {
  claimed: number;
  completed: number;
  failed: number;
}

@Injectable()
export class AiJobsWorkerService {
  private readonly logger = new Logger(AiJobsWorkerService.name);
  private readonly claimer: AiJobsFairClaimer;

  constructor(
    private readonly jobs: AiJobsService,
    private readonly registry: AiJobHandlerRegistry,
    @Inject(DRIZZLE) private readonly db: Db,
    @Optional() @Inject(AI_JOB_HANDLERS) handlers: AiJobHandler[] | null,
  ) {
    for (const handler of handlers ?? []) {
      registry.register(handler);
    }
    this.claimer = new AiJobsFairClaimer(db);
  }

  async flush(limit = 25): Promise<FlushResult> {
    const release = await poolAdmission.acquire("background");
    try {
      return await this.runFlush(limit);
    } finally {
      release();
    }
  }

  private async runFlush(limit: number): Promise<FlushResult> {
    const workerId = `worker-${process.pid}-${Date.now()}`;
    const reclaimed = await this.jobs.reclaimExpiredLeases();
    if (reclaimed > 0) {
      this.logger.warn("Reclaimed AI jobs from expired leases", { reclaimed });
    }
    const batch = await this.claimLaneBalanced(workerId, limit);
    const result: FlushResult = { claimed: batch.length, completed: 0, failed: 0 };

    for (const job of batch) {
      const handler = this.registry.resolve(job.type);
      if (!handler) {
        const errMsg = `No handler registered for type "${job.type}"`;
        this.logger.warn(`AI job ${job.id}: ${errMsg}`);
        await this.db
          .update(aiJobs)
          .set({ status: "DEAD", attempts: job.maxAttempts, lastError: errMsg, lockedBy: null, lockedAt: null })
          .where(and(eq(aiJobs.id, job.id), eq(aiJobs.orgId, job.orgId)));
        result.failed += 1;
        continue;
      }

      try {
        const output = await handler.handle({
          id: job.id,
          orgId: job.orgId,
          userId: job.userId,
          payload: job.payload,
        });
        await this.jobs.complete(job.orgId, job.id, output);
        result.completed += 1;
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        this.logger.error(`AI job ${job.id} (${job.type}) failed: ${errMsg}`);
        await this.jobs.fail(job.orgId, job.id, errMsg);
        result.failed += 1;
      }
    }

    return result;
  }

  private async claimLaneBalanced(workerId: string, limit: number): Promise<AiJob[]> {
    const lanes = this.registry.types();
    if (lanes.length < 2) {
      return this.claimer.claim(workerId, limit, FAIR_CLAIM_DEFAULT_PER_ORG_LIMIT);
    }

    const claimed: AiJob[] = [];
    const perLane = Math.max(1, Math.floor(limit / lanes.length));

    for (const type of lanes) {
      if (claimed.length >= limit) break;
      const laneLimit = Math.min(perLane, limit - claimed.length);
      const rows = await this.claimer.claim(
        workerId,
        laneLimit,
        FAIR_CLAIM_DEFAULT_PER_ORG_LIMIT,
        [type],
      );
      claimed.push(...rows);
    }

    const remaining = limit - claimed.length;
    if (remaining > 0) {
      const rows = await this.claimer.claim(
        workerId,
        remaining,
        FAIR_CLAIM_DEFAULT_PER_ORG_LIMIT,
      );
      claimed.push(...rows);
    }

    return claimed;
  }
}
