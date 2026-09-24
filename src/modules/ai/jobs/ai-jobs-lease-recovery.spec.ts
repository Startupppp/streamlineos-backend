import {
  AiJobsService,
  JOB_LEASE_TIMEOUT_MS,
  LEASE_EXPIRED_ERROR,
} from "./ai-jobs.service";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";

function makeDb(rows: unknown[] = []): { db: Db; statements: string[]; params: unknown[][] } {
  const dialect = new PgDialect();
  const statements: string[] = [];
  const params: unknown[][] = [];
  const db = {
    execute: jest.fn((query: SQL) => {
      const rendered = dialect.sqlToQuery(query);
      statements.push(rendered.sql);
      params.push(rendered.params);
      return Promise.resolve(rows);
    }),
  } as unknown as Db;
  return { db, statements, params };
}

describe("AiJobsService.reclaimExpiredLeases", () => {
  it("selects only RUNNING rows, because a QUEUED job holds no lease to expire", async () => {
    const { db, statements } = makeDb([]);

    await new AiJobsService(db).reclaimExpiredLeases();

    expect(statements[0]).toContain("'RUNNING'");
    expect(statements[0]).toContain("locked_at <");
  });

  it("requires locked_at to be non-null, so a RUNNING row with no lease is not swept up", async () => {
    const { db, statements } = makeDb([]);

    await new AiJobsService(db).reclaimExpiredLeases();

    expect(statements[0]).toContain("locked_at IS NOT NULL");
  });

  it("binds a cutoff one lease-timeout in the past, not the current instant", async () => {
    const now = new Date("2026-03-01T12:00:00.000Z");
    const { db, params } = makeDb([]);

    await new AiJobsService(db).reclaimExpiredLeases(now);

    const cutoff = new Date(now.getTime() - JOB_LEASE_TIMEOUT_MS).toISOString();
    expect(params[0]).toContain(cutoff);
    expect(Date.parse(cutoff)).toBeLessThan(now.getTime());
  });

  it("does not sweep a lease taken moments ago, which would steal jobs from live workers", async () => {
    const now = new Date("2026-03-01T12:00:00.000Z");
    const { db, params } = makeDb([]);

    await new AiJobsService(db).reclaimExpiredLeases(now);

    const cutoff = String(
      params[0].find(
        (p) => typeof p === "string" && p !== now.toISOString() && p.endsWith("Z"),
      ),
    );
    const freshLease = new Date(now.getTime() - 1_000);
    expect(freshLease.getTime()).toBeGreaterThan(Date.parse(cutoff));
  });

  it("counts the reclaim as an attempt, so a job that kills its worker cannot loop forever", async () => {
    const { db, statements } = makeDb([]);

    await new AiJobsService(db).reclaimExpiredLeases();

    expect(statements[0]).toContain("attempts = attempts + 1");
  });

  it("dead-letters a reclaimed job that has reached max_attempts instead of requeueing it", async () => {
    const { db, statements } = makeDb([]);

    await new AiJobsService(db).reclaimExpiredLeases();

    expect(statements[0]).toContain("attempts + 1 >= max_attempts");
    expect(statements[0]).toContain("'DEAD'");
    expect(statements[0]).toContain("'QUEUED'");
  });

  it("clears the lease so the next claim can take the row", async () => {
    const { db, statements } = makeDb([]);

    await new AiJobsService(db).reclaimExpiredLeases();

    expect(statements[0]).toContain("locked_by = NULL");
    expect(statements[0]).toContain("locked_at = NULL");
  });

  it("records why the job was requeued rather than leaving the prior error in place", async () => {
    const { db, params } = makeDb([]);

    await new AiJobsService(db).reclaimExpiredLeases();

    expect(params[0]).toContain(LEASE_EXPIRED_ERROR);
  });

  it("reports how many rows it reclaimed, so the caller can log a real number", async () => {
    const { db } = makeDb([{ id: 1 }, { id: 2 }, { id: 3 }]);

    expect(await new AiJobsService(db).reclaimExpiredLeases()).toBe(3);
  });

  it("reports zero when no lease has expired, pairing the count above", async () => {
    const { db } = makeDb([]);

    expect(await new AiJobsService(db).reclaimExpiredLeases()).toBe(0);
  });
});


describe("AiJobsService.claimBatch", () => {
  it("claims only QUEUED rows that are already due, leaving future-dated work alone", async () => {
    const { db, statements } = makeDb([]);

    await new AiJobsService(db).claimBatch("worker-1", 20);

    expect(statements[0]).toContain("status = 'QUEUED'");
    expect(statements[0]).toContain("run_at <=");
  });

  it("orders by priority then age, so a high-priority job is not stuck behind older low-priority work", async () => {
    const { db, statements } = makeDb([]);

    await new AiJobsService(db).claimBatch("worker-1", 20);

    expect(statements[0]).toContain("priority DESC");
    expect(statements[0]).toContain("run_at ASC");
  });

  it("re-checks the status inside the locking select, so two workers cannot claim one job", async () => {
    const { db, statements } = makeDb([]);

    await new AiJobsService(db).claimBatch("worker-1", 20);

    const locking = statements[0].slice(statements[0].indexOf("SELECT id FROM ai_jobs"));
    expect(locking).toContain("status = 'QUEUED'");
    expect(locking.indexOf("status = 'QUEUED'")).toBeLessThan(
      locking.indexOf("FOR UPDATE SKIP LOCKED"),
    );
  });

  it("skips rows another worker already holds rather than blocking behind them", async () => {
    const { db, statements } = makeDb([]);

    await new AiJobsService(db).claimBatch("worker-1", 20);

    expect(statements[0]).toContain("FOR UPDATE SKIP LOCKED");
  });

  it("marks what it takes as RUNNING under the calling worker's id", async () => {
    const { db, statements, params } = makeDb([]);

    await new AiJobsService(db).claimBatch("worker-7", 20);

    expect(statements[0]).toContain("'RUNNING'");
    expect(params[0]).toContain("worker-7");
  });
});
