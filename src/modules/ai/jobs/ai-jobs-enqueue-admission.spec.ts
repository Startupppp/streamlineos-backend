import { ConflictException, HttpException, HttpStatus } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  AiJobsService,
  LIVE_JOB_STATUSES,
  MAX_LIVE_JOBS_PER_ORG,
  QUEUE_DEPTH_EXCEEDED_CODE,
  QUEUE_DEPTH_RETRY_AFTER_SECONDS,
  REVIVABLE_JOB_STATUSES,
} from "./ai-jobs.service";
import type { EnqueueInput } from "./ai-jobs.service";
import type { Db } from "../../../db/drizzle.module";
import type { AiJob } from "../../../db/schema";
import {
  drizzlePostgresError,
  drizzleUniqueViolation,
} from "../../../test/postgres-error-fixture";

const EXISTING_JOB_ID = 77;
const INSERTED_JOB_ID = 4242;

type Rendered = { sql: string; params: unknown[] };

type Harness = {
  db: Db;
  updates: (Rendered & { set: Record<string, unknown> })[];
  inserts: Record<string, unknown>[];
  selects: Rendered[];
};

function existingJob(status: AiJob["status"]): Partial<AiJob> {
  return {
    id: EXISTING_JOB_ID,
    orgId: "org-a",
    status,
    attempts: 3,
    maxAttempts: 3,
    idempotencyKey: "crm.stale-pipeline:2026-03-01",
  };
}

function makeDb(
  opts: {
    existing?: Partial<AiJob> | null;
    liveCount?: number;
    insertRejects?: unknown;
  } = {},
): Harness {
  const dialect = new PgDialect();
  const updates: Harness["updates"] = [];
  const inserts: Harness["inserts"] = [];
  const selects: Harness["selects"] = [];

  const db = {
    query: {
      aiJobs: {
        findFirst: jest.fn(() => Promise.resolve(opts.existing ?? undefined)),
      },
    },
    select: () => ({
      from: () => ({
        where: (condition: SQL) => {
          selects.push(dialect.sqlToQuery(condition));
          return Promise.resolve([{ live: opts.liveCount ?? 0 }]);
        },
      }),
    }),
    update: () => ({
      set: (set: Record<string, unknown>) => ({
        where: (condition: SQL) => {
          updates.push({ set, ...dialect.sqlToQuery(condition) });
          return Promise.resolve([]);
        },
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        returning: () => {
          inserts.push(values);
          if (opts.insertRejects !== undefined) return Promise.reject(opts.insertRejects);
          return Promise.resolve([{ id: INSERTED_JOB_ID }]);
        },
      }),
    }),
  } as unknown as Db;

  return { db, updates, inserts, selects };
}

function enqueueInput(overrides: Partial<EnqueueInput> = {}): EnqueueInput {
  return {
    orgId: "org-a",
    type: "crm.stale-pipeline",
    payload: { window: 30 },
    idempotencyKey: "crm.stale-pipeline:2026-03-01",
    ...overrides,
  };
}

describe("AiJobsService.enqueue idempotency replay by status", () => {
  it("revives a DEAD row instead of handing back the dead one, because the no-handler branch would otherwise poison the key forever", async () => {
    const { db, updates } = makeDb({ existing: existingJob("DEAD") });

    const result = await new AiJobsService(db).enqueue(enqueueInput());

    expect(updates).toHaveLength(1);
    expect(updates[0]?.set["status"]).not.toBe("DEAD");
    expect(updates[0]?.set["status"]).toBe("QUEUED");
    expect(result.jobId).toBe(EXISTING_JOB_ID);
  });

  it("resets attempts to zero when reviving, because a row left at max_attempts dead-letters again on its first claim", async () => {
    const { db, updates } = makeDb({ existing: existingJob("DEAD") });

    await new AiJobsService(db).enqueue(enqueueInput());

    expect(updates[0]?.set["attempts"]).toBe(0);
  });

  it("clears the prior failure and lease when reviving, so the retried job does not report the dead run's error", async () => {
    const { db, updates } = makeDb({ existing: existingJob("DEAD") });

    await new AiJobsService(db).enqueue(enqueueInput());

    expect(updates[0]?.set["lastError"]).toBeNull();
    expect(updates[0]?.set["result"]).toBeNull();
    expect(updates[0]?.set["lockedBy"]).toBeNull();
    expect(updates[0]?.set["lockedAt"]).toBeNull();
  });

  it("revives a FAILED row on the same terms as DEAD, because both are terminal failures the caller is explicitly retrying", async () => {
    const { db, updates } = makeDb({ existing: existingJob("FAILED") });

    await new AiJobsService(db).enqueue(enqueueInput());

    expect(updates).toHaveLength(1);
    expect(updates[0]?.set["status"]).toBe("QUEUED");
  });

  it("updates in place rather than inserting a second row, because uq_ai_jobs_org_idem_key admits only one row per (org_id, idempotency_key)", async () => {
    const { db, updates, inserts } = makeDb({ existing: existingJob("DEAD") });

    await new AiJobsService(db).enqueue(enqueueInput());

    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(1);
  });

  it("guards the revive UPDATE on the terminal statuses, so a row a worker claimed between the read and the write is not yanked back to QUEUED", async () => {
    const { db, updates } = makeDb({ existing: existingJob("DEAD") });

    await new AiJobsService(db).enqueue(enqueueInput());

    expect(updates[0]?.sql).toContain("status");
    expect(updates[0]?.sql).toContain("in (");
    for (const status of REVIVABLE_JOB_STATUSES) {
      expect(updates[0]?.params).toContain(status);
    }
    expect(updates[0]?.params).not.toContain("RUNNING");
  });

  it("scopes the revive UPDATE to the caller's org as well as the row id, so a guessed id cannot reach another tenant's job", async () => {
    const { db, updates } = makeDb({ existing: existingJob("DEAD") });

    await new AiJobsService(db).enqueue(enqueueInput({ orgId: "org-a" }));

    expect(updates[0]?.params).toContain(EXISTING_JOB_ID);
    expect(updates[0]?.params).toContain("org-a");
  });

  it("returns a COMPLETED row untouched, because replaying a finished job is the duplicate-execution bug idempotency exists to prevent", async () => {
    const { db, updates, inserts } = makeDb({ existing: existingJob("COMPLETED") });

    const result = await new AiJobsService(db).enqueue(enqueueInput());

    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
    expect(result.jobId).toBe(EXISTING_JOB_ID);
  });

  it("returns a RUNNING row untouched, because a worker holds its lease and re-queueing it would run the work twice", async () => {
    const { db, updates, inserts } = makeDb({ existing: existingJob("RUNNING") });

    const result = await new AiJobsService(db).enqueue(enqueueInput());

    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
    expect(result.jobId).toBe(EXISTING_JOB_ID);
  });

  it("returns a QUEUED row untouched, because the work is already waiting and a reset would only move it behind itself", async () => {
    const { db, updates, inserts } = makeDb({ existing: existingJob("QUEUED") });

    const result = await new AiJobsService(db).enqueue(enqueueInput());

    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
    expect(result.jobId).toBe(EXISTING_JOB_ID);
  });

  it("returns a CANCELLED row untouched, because reviving it would silently undo an operator's explicit cancel", async () => {
    const { db, updates, inserts } = makeDb({ existing: existingJob("CANCELLED") });

    const result = await new AiJobsService(db).enqueue(enqueueInput());

    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
    expect(result.jobId).toBe(EXISTING_JOB_ID);
  });

  it("inserts a fresh row when the key has never been used, pairing the replay branches above", async () => {
    const { db, updates, inserts } = makeDb({ existing: null });

    const result = await new AiJobsService(db).enqueue(enqueueInput());

    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(1);
    expect(result.jobId).toBe(INSERTED_JOB_ID);
  });

  it("skips the idempotency read entirely when no key is supplied, so unkeyed work is never deduplicated against a stranger's row", async () => {
    const { db, inserts } = makeDb({ existing: existingJob("DEAD") });
    const service = new AiJobsService(db);

    const result = await service.enqueue(enqueueInput({ idempotencyKey: undefined }));

    expect(inserts).toHaveLength(1);
    expect(result.jobId).toBe(INSERTED_JOB_ID);
  });
});

describe("AiJobsService.enqueue per-org admission control", () => {
  it("rejects an org at the cap with 429, because one tenant filling the queue starves every other tenant's claims", async () => {
    const { db, inserts } = makeDb({ existing: null, liveCount: MAX_LIVE_JOBS_PER_ORG });

    await expect(new AiJobsService(db).enqueue(enqueueInput())).rejects.toBeInstanceOf(
      HttpException,
    );
    expect(inserts).toHaveLength(0);
  });

  it("answers the rejection with TOO_MANY_REQUESTS rather than a 500, so the caller can tell backpressure from a fault", async () => {
    const { db } = makeDb({ existing: null, liveCount: MAX_LIVE_JOBS_PER_ORG });
    let thrown: unknown;

    try {
      await new AiJobsService(db).enqueue(enqueueInput());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
  });

  it("carries a positive retryAfterSecs on the rejection body, because BE-22 requires a Retry-After on every 429", async () => {
    const { db } = makeDb({ existing: null, liveCount: MAX_LIVE_JOBS_PER_ORG + 50 });
    let body: unknown;

    try {
      await new AiJobsService(db).enqueue(enqueueInput());
    } catch (error) {
      body = (error as HttpException).getResponse();
    }

    const payload = body as Record<string, unknown>;
    expect(payload["code"]).toBe(QUEUE_DEPTH_EXCEEDED_CODE);
    expect(payload["retryAfterSecs"]).toBe(QUEUE_DEPTH_RETRY_AFTER_SECONDS);
    expect(QUEUE_DEPTH_RETRY_AFTER_SECONDS).toBeGreaterThan(0);
  });

  it("admits an org one job below the cap, pairing the rejection so the cap is not simply refusing everything", async () => {
    const { db, inserts } = makeDb({ existing: null, liveCount: MAX_LIVE_JOBS_PER_ORG - 1 });

    const result = await new AiJobsService(db).enqueue(enqueueInput());

    expect(inserts).toHaveLength(1);
    expect(result.jobId).toBe(INSERTED_JOB_ID);
  });

  it("counts only QUEUED and RUNNING rows, because a COMPLETED or DEAD row occupies no worker and must not consume capacity", async () => {
    const { db, selects } = makeDb({ existing: null, liveCount: 0 });

    await new AiJobsService(db).enqueue(enqueueInput());

    expect(selects).toHaveLength(1);
    for (const status of LIVE_JOB_STATUSES) {
      expect(selects[0]?.params).toContain(status);
    }
    expect(selects[0]?.params).not.toContain("COMPLETED");
    expect(selects[0]?.params).not.toContain("DEAD");
  });

  it("scopes the depth count to the caller's org, because a global count would let a busy tenant lock out a quiet one", async () => {
    const { db, selects } = makeDb({ existing: null, liveCount: 0 });

    await new AiJobsService(db).enqueue(enqueueInput({ orgId: "org-b" }));

    expect(selects[0]?.params).toContain("org-b");
  });

  it("admits a re-enqueue of an existing key while the org sits far above the cap, because a replay consumes no new capacity", async () => {
    const { db, selects } = makeDb({
      existing: existingJob("COMPLETED"),
      liveCount: MAX_LIVE_JOBS_PER_ORG * 2,
    });

    const result = await new AiJobsService(db).enqueue(enqueueInput());

    expect(result.jobId).toBe(EXISTING_JOB_ID);
    expect(selects).toHaveLength(0);
  });

  it("revives a DEAD key while the org sits above the cap, because the poisoned-key fix must not be gated behind admission", async () => {
    const { db, updates, selects } = makeDb({
      existing: existingJob("DEAD"),
      liveCount: MAX_LIVE_JOBS_PER_ORG * 2,
    });

    const result = await new AiJobsService(db).enqueue(enqueueInput());

    expect(updates[0]?.set["status"]).toBe("QUEUED");
    expect(result.jobId).toBe(EXISTING_JOB_ID);
    expect(selects).toHaveLength(0);
  });
});

describe("AiJobsService.enqueue unique violation handling", () => {
  it("turns a 23505 from the idempotency index into a 409, because a lost race must not surface as a 500 (BE-41)", async () => {
    const { db } = makeDb({
      existing: null,
      insertRejects: drizzleUniqueViolation("uq_ai_jobs_org_idem_key"),
    });
    let thrown: unknown;

    try {
      await new AiJobsService(db).enqueue(enqueueInput());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConflictException);
    expect((thrown as ConflictException).getStatus()).toBe(HttpStatus.CONFLICT);
  });

  it("rethrows a non-unique database error untouched, so a foreign-key failure is not mislabelled as a conflict", async () => {
    const violation = drizzlePostgresError("23503", "fk_ai_jobs_org_user_mbr");
    const { db } = makeDb({ existing: null, insertRejects: violation });

    await expect(new AiJobsService(db).enqueue(enqueueInput())).rejects.toBe(violation);
  });
});
