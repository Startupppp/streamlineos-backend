import { AiJobsWorkerService } from "./ai-jobs-worker.service";
import { AiJobHandlerRegistry } from "./ai-job-handler";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { AiJob } from "../../../db/schema";

const dialect = new PgDialect();

function makeJob(overrides?: Partial<AiJob>): AiJob {
  return {
    id: 99,
    orgId: "org-test-abc",
    userId: null,
    userMembershipId: null,
    type: "UNREGISTERED_TYPE",
    payload: {},
    status: "RUNNING",
    priority: 0,
    attempts: 0,
    maxAttempts: 3,
    idempotencyKey: null,
    correlationId: null,
    runAt: new Date(),
    lockedBy: null,
    lockedAt: null,
    lastError: null,
    result: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeClaimRow(job: AiJob): Record<string, unknown> {
  return {
    id: job.id,
    org_id: job.orgId,
    user_id: job.userId,
    user_membership_id: job.userMembershipId,
    type: job.type,
    payload: job.payload,
    status: job.status,
    priority: job.priority,
    attempts: job.attempts,
    max_attempts: job.maxAttempts,
    idempotency_key: job.idempotencyKey,
    correlation_id: job.correlationId,
    run_at: job.runAt.toISOString(),
    locked_by: job.lockedBy,
    locked_at: job.lockedAt?.toISOString() ?? null,
    last_error: job.lastError,
    result: job.result,
    created_at: job.createdAt.toISOString(),
    updated_at: job.updatedAt.toISOString(),
  };
}

function buildDb(overrides: {
  claimJob?: AiJob;
  updateCapture?: SQL[];
}): { db: unknown } {
  const capturedConditions = overrides.updateCapture ?? [];
  let execCallCount = 0;
  const claimRow = overrides.claimJob ? makeClaimRow(overrides.claimJob) : null;

  return {
    db: {
      execute: jest.fn(() => {
        const idx = execCallCount++;
        if (idx === 0) {
          return Promise.resolve(
            claimRow ? [{ org_id: (claimRow["org_id"] as string) }] : [],
          );
        }
        return Promise.resolve(claimRow ? [claimRow] : []);
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation((cond: SQL) => {
            capturedConditions.push(cond);
            return Promise.resolve();
          }),
        }),
      }),
    },
  };
}

describe("AiJobsWorkerService — DEAD-status update predicate", () => {
  it("includes org_id in the where clause when no handler is registered for the job type", async () => {
    const capturedConditions: SQL[] = [];
    const { db } = buildDb({ claimJob: makeJob(), updateCapture: capturedConditions });

    const jobs = {
      reclaimExpiredLeases: jest.fn().mockResolvedValue(0),
      complete: jest.fn(),
      fail: jest.fn(),
    };

    const registry = new AiJobHandlerRegistry();
    const svc = new AiJobsWorkerService(jobs as never, registry, db as never, null);
    await svc.flush(1);

    expect(capturedConditions).toHaveLength(1);
    const rendered = dialect.sqlToQuery(capturedConditions[0] as SQL).sql;
    expect(rendered).toContain("id");
    expect(rendered).toContain("org_id");
  });
});
