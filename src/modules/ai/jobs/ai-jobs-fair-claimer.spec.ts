import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { AiJobsFairClaimer, FAIR_CLAIM_DEFAULT_PER_ORG_LIMIT } from "./ai-jobs-fair-claimer";

const dialect = new PgDialect();

interface ExecuteCall {
  sql: string;
  params: unknown[];
}

function makeDb(config: {
  orgIds?: string[];
  claimRowsByOrg?: Record<string, Record<string, unknown>[]>;
}): { db: unknown; calls: ExecuteCall[] } {
  const calls: ExecuteCall[] = [];
  let callCount = 0;
  const orgCallResult = (config.orgIds ?? []).map((id) => ({ org_id: id }));

  return {
    db: {
      execute: jest.fn((query: SQL) => {
        const rendered = dialect.sqlToQuery(query);
        calls.push({ sql: rendered.sql, params: rendered.params });
        const index = callCount++;
        if (index === 0) return Promise.resolve(orgCallResult);
        const orgId = config.orgIds?.[index - 1];
        const rows = (orgId && config.claimRowsByOrg?.[orgId]) ?? [];
        return Promise.resolve(rows);
      }),
    },
    calls,
  };
}

function makeClaimRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 1,
    org_id: "org-a",
    user_id: null,
    user_membership_id: null,
    type: "kb.embed",
    payload: {},
    status: "RUNNING",
    priority: 0,
    attempts: 0,
    max_attempts: 3,
    idempotency_key: null,
    run_at: new Date().toISOString(),
    locked_by: "worker-1",
    locked_at: new Date().toISOString(),
    last_error: null,
    result: null,
    correlation_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("AiJobsFairClaimer — SQL correctness", () => {
  it("keeps status = 'QUEUED' in the inner SELECT before FOR UPDATE SKIP LOCKED, so two workers cannot claim the same job", async () => {
    const { db, calls } = makeDb({ orgIds: ["org-a"], claimRowsByOrg: { "org-a": [] } });

    const claimer = new AiJobsFairClaimer(db as never);
    await claimer.claim("worker-1", 10, 5);

    expect(calls).toHaveLength(2);
    const claimSql = calls[1]?.sql ?? "";
    const innerSelect = claimSql.slice(claimSql.indexOf("SELECT id FROM ai_jobs"));
    expect(innerSelect).toContain("status = 'QUEUED'");
    expect(innerSelect.indexOf("status = 'QUEUED'")).toBeLessThan(
      innerSelect.indexOf("FOR UPDATE SKIP LOCKED"),
    );
  });

  it("skips rows another worker has locked rather than blocking behind them", async () => {
    const { db, calls } = makeDb({ orgIds: ["org-a"], claimRowsByOrg: { "org-a": [] } });

    const claimer = new AiJobsFairClaimer(db as never);
    await claimer.claim("worker-1", 10, 5);

    expect(calls[1]?.sql).toContain("FOR UPDATE SKIP LOCKED");
  });

  it("includes only QUEUED rows that are already due, leaving future-dated work alone", async () => {
    const { db, calls } = makeDb({ orgIds: ["org-a"], claimRowsByOrg: { "org-a": [] } });

    const claimer = new AiJobsFairClaimer(db as never);
    await claimer.claim("worker-1", 10, 5);

    const claimSql = calls[1]?.sql ?? "";
    const innerSelect = claimSql.slice(claimSql.indexOf("SELECT id FROM ai_jobs"));
    expect(innerSelect).toContain("status = 'QUEUED'");
    expect(innerSelect).toContain("run_at <=");
  });

  it("sets status RUNNING and locks to the calling worker id", async () => {
    const { db, calls } = makeDb({ orgIds: ["org-a"], claimRowsByOrg: { "org-a": [] } });

    const claimer = new AiJobsFairClaimer(db as never);
    await claimer.claim("worker-abc", 10, 5);

    expect(calls[1]?.sql).toContain("status = 'RUNNING'");
    expect(calls[1]?.params).toContain("worker-abc");
  });

  it("includes a type IN filter in the inner SELECT when types are provided, so a worker claims only its registered kinds", async () => {
    const { db, calls } = makeDb({ orgIds: ["org-a"], claimRowsByOrg: { "org-a": [] } });

    const claimer = new AiJobsFairClaimer(db as never);
    await claimer.claim("worker-1", 10, 5, ["kb.embed", "hr.score"]);

    const claimSql = calls[1]?.sql ?? "";
    const innerSelect = claimSql.slice(claimSql.indexOf("SELECT id FROM ai_jobs"));
    expect(innerSelect).toContain("type IN");
    expect(calls[1]?.params).toContain("kb.embed");
    expect(calls[1]?.params).toContain("hr.score");
    expect(innerSelect).toContain("status = 'QUEUED'");
  });

  it("omits the type filter entirely when no types are provided, so an unfiltered worker claims any kind", async () => {
    const { db, calls } = makeDb({ orgIds: ["org-a"], claimRowsByOrg: { "org-a": [] } });

    const claimer = new AiJobsFairClaimer(db as never);
    await claimer.claim("worker-1", 10, 5);

    expect(calls[1]?.sql).not.toContain("type IN");
  });
});

describe("AiJobsFairClaimer — per-tenant fairness", () => {
  it("claims from org-b even when org-a fills its per-org cap, so a backlogged tenant cannot starve others", async () => {
    const orgARow = makeClaimRow({ org_id: "org-a", id: 1 });
    const orgBRow = makeClaimRow({ org_id: "org-b", id: 2 });

    const { db } = makeDb({
      orgIds: ["org-a", "org-b"],
      claimRowsByOrg: { "org-a": [orgARow], "org-b": [orgBRow] },
    });

    const claimer = new AiJobsFairClaimer(db as never);
    const jobs = await claimer.claim("worker-1", 10, 1);

    expect(jobs.map((j) => j.orgId)).toContain("org-a");
    expect(jobs.map((j) => j.orgId)).toContain("org-b");
  });

  it("advances the cursor past the last claimed org when the batch fills, so the next claim starts where this one stopped", async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      makeClaimRow({ org_id: "org-a", id: i + 1 }),
    );

    const calls: ExecuteCall[] = [];
    let callCount = 0;

    const db = {
      execute: jest.fn((query: SQL) => {
        const rendered = dialect.sqlToQuery(query);
        calls.push({ sql: rendered.sql, params: rendered.params });
        if (callCount++ === 0) return Promise.resolve([{ org_id: "org-a" }, { org_id: "org-b" }]);
        return Promise.resolve(rows);
      }),
    };

    const claimer = new AiJobsFairClaimer(db as never);
    await claimer.claim("worker-1", 5, 5);

    const secondCalls: ExecuteCall[] = [];
    let secondCallCount = 0;
    const db2 = {
      execute: jest.fn((query: SQL) => {
        const rendered = dialect.sqlToQuery(query);
        secondCalls.push({ sql: rendered.sql, params: rendered.params });
        if (secondCallCount++ === 0)
          return Promise.resolve([{ org_id: "org-a" }, { org_id: "org-b" }]);
        return Promise.resolve([]);
      }),
    };
    (claimer as unknown as { db: unknown }).db = db2 as never;

    await claimer.claim("worker-1", 5, 5);

    const firstOrgId = secondCalls[1]?.params.find(
      (p) => typeof p === "string" && p.startsWith("org-"),
    );
    expect(firstOrgId).toBe("org-b");
  });

  it("resets the cursor when the batch is not full, so the next claim starts fresh from all orgs", async () => {
    const calls: ExecuteCall[] = [];
    let callCount = 0;

    const db = {
      execute: jest.fn((query: SQL) => {
        const rendered = dialect.sqlToQuery(query);
        calls.push({ sql: rendered.sql, params: rendered.params });
        if (callCount++ === 0) return Promise.resolve([{ org_id: "org-a" }]);
        return Promise.resolve([makeClaimRow({ org_id: "org-a", id: 1 })]);
      }),
    };

    const claimer = new AiJobsFairClaimer(db as never);
    await claimer.claim("worker-1", 10, 5);

    const secondCalls: ExecuteCall[] = [];
    let secondCallCount = 0;
    const db2 = {
      execute: jest.fn((query: SQL) => {
        const rendered = dialect.sqlToQuery(query);
        secondCalls.push({ sql: rendered.sql, params: rendered.params });
        if (secondCallCount++ === 0) return Promise.resolve([{ org_id: "org-a" }]);
        return Promise.resolve([]);
      }),
    };
    (claimer as unknown as { db: unknown }).db = db2 as never;

    await claimer.claim("worker-1", 10, 5);

    const firstOrgId = secondCalls[1]?.params.find(
      (p) => typeof p === "string" && p.startsWith("org-"),
    );
    expect(firstOrgId).toBe("org-a");
  });

  it("stops claiming once the batch limit is reached, so a worker does not overshoot its quota", async () => {
    let callCount = 0;
    const orgARow = makeClaimRow({ org_id: "org-a", id: 1 });

    const db = {
      execute: jest.fn(() => {
        if (callCount++ === 0)
          return Promise.resolve([{ org_id: "org-a" }, { org_id: "org-b" }]);
        return Promise.resolve([orgARow]);
      }),
    };

    const claimer = new AiJobsFairClaimer(db as never);
    const jobs = await claimer.claim("worker-1", 1, FAIR_CLAIM_DEFAULT_PER_ORG_LIMIT);

    expect(jobs).toHaveLength(1);
    expect((db.execute as jest.Mock).mock.calls).toHaveLength(2);
  });

  it("returns an empty array when no orgs have pending work", async () => {
    const { db } = makeDb({ orgIds: [] });

    const claimer = new AiJobsFairClaimer(db as never);
    const jobs = await claimer.claim("worker-1", 10, 5);

    expect(jobs).toHaveLength(0);
  });
});

describe("AiJobsFairClaimer — correlation id", () => {
  it("passes the correlation_id from the row through to the returned job, so callers can trace a job back to its originating request", async () => {
    const row = makeClaimRow({ org_id: "org-a", correlation_id: "req-trace-abc" });
    const { db } = makeDb({ orgIds: ["org-a"], claimRowsByOrg: { "org-a": [row] } });

    const claimer = new AiJobsFairClaimer(db as never);
    const jobs = await claimer.claim("worker-1", 10, 5);

    expect(jobs[0]?.correlationId).toBe("req-trace-abc");
  });

  it("sets correlationId to null when the row has no correlation_id, pairing the case above", async () => {
    const row = makeClaimRow({ org_id: "org-a", correlation_id: null });
    const { db } = makeDb({ orgIds: ["org-a"], claimRowsByOrg: { "org-a": [row] } });

    const claimer = new AiJobsFairClaimer(db as never);
    const jobs = await claimer.claim("worker-1", 10, 5);

    expect(jobs[0]?.correlationId).toBeNull();
  });
});
