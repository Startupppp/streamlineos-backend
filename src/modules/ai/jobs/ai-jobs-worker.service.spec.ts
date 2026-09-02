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

describe("AiJobsWorkerService — DEAD-status update predicate", () => {
  it("includes org_id in the where clause when no handler is registered for the job type", async () => {
    const capturedConditions: SQL[] = [];

    const db = {
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation((cond: SQL) => {
            capturedConditions.push(cond);
            return Promise.resolve();
          }),
        }),
      }),
    };

    const jobs = {
      claimBatch: jest.fn().mockResolvedValue([makeJob()]),
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
