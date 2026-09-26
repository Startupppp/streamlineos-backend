import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { AiJobsWorkerService } from "./ai-jobs-worker.service";
import { AiJobHandlerRegistry, type AiJobHandler } from "./ai-job-handler";

const dialect = new PgDialect();

interface ExecuteCall {
  sql: string;
  params: unknown[];
}

function makeHandler(type: string): AiJobHandler {
  return { type, handle: jest.fn().mockResolvedValue({}) };
}

function buildDb(): { db: unknown; calls: ExecuteCall[] } {
  const calls: ExecuteCall[] = [];
  return {
    db: {
      execute: jest.fn((query: SQL) => {
        const rendered = dialect.sqlToQuery(query);
        calls.push({ sql: rendered.sql, params: rendered.params });
        if (rendered.sql.includes("SELECT DISTINCT org_id"))
          return Promise.resolve([{ org_id: "org-a" }]);
        return Promise.resolve([]);
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
      }),
    },
    calls,
  };
}

describe("AiJobsWorkerService — dedicated queue lanes", () => {
  it("claims a bounded share for every registered job type instead of one unfiltered batch, so a burst of one type cannot exhaust the flush limit before other types are tried", async () => {
    const { db, calls } = buildDb();
    const registry = new AiJobHandlerRegistry();
    registry.register(makeHandler("kb.research-brief"));
    registry.register(makeHandler("workflow.ai_node"));

    const jobs = {
      reclaimExpiredLeases: jest.fn().mockResolvedValue(0),
      complete: jest.fn(),
      fail: jest.fn(),
    };

    const svc = new AiJobsWorkerService(jobs as never, registry, db as never, null);
    await svc.flush(10);

    const claimCalls = calls.filter((c) => c.sql.includes("UPDATE ai_jobs"));
    const laneFiltered = claimCalls.filter((c) => c.sql.includes("type IN"));

    const coversKbBrief = laneFiltered.some((c) => c.params.includes("kb.research-brief"));
    const coversWorkflow = laneFiltered.some((c) => c.params.includes("workflow.ai_node"));

    expect(coversKbBrief).toBe(true);
    expect(coversWorkflow).toBe(true);
  });

  it("does not fragment the batch into per-type lanes when only one job type is registered", async () => {
    const { db, calls } = buildDb();
    const registry = new AiJobHandlerRegistry();
    registry.register(makeHandler("kb.research-brief"));

    const jobs = {
      reclaimExpiredLeases: jest.fn().mockResolvedValue(0),
      complete: jest.fn(),
      fail: jest.fn(),
    };

    const svc = new AiJobsWorkerService(jobs as never, registry, db as never, null);
    await svc.flush(10);

    const claimCalls = calls.filter((c) => c.sql.includes("UPDATE ai_jobs"));
    expect(claimCalls).toHaveLength(1);
  });
});
