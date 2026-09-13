import type { Db } from "../../db/drizzle.types";
import { OutboxWriter } from "../outbox/outbox-writer";
import { runWithObservabilityContext, getObservabilityContext } from "../observability";
import {
  resetSpanExporter,
  setSpanExporter,
  type FinishedSpan,
} from "../observability/tracing";
import { WorkflowRegistry } from "./workflow-registry";
import { WorkflowOutboxRelayService } from "./workflow-outbox-relay.service";
import { WorkflowRunnerService } from "./workflow-runner.service";
import { claimDueRuns, startRun } from "./workflow-store";

const mockRunInNewTenantTransaction = jest.fn();

/**
 * The runtime reads and writes inside a tenant transaction now, so these doubles
 * hand the test's own `db` back as the transaction. That keeps every double in
 * this file describing the query it always described, while the code under test
 * takes the per-organisation path that row-level security requires — the
 * cross-tenant form it used to take was denied outright as the application role.
 */
jest.mock("../tenant", () => ({
  forEachOrg: async (
    db: unknown,
    _sweep: string,
    fn: (tx: unknown, orgId: string) => Promise<void>,
  ) => {
    await fn(db, "org-1");
    return { organizations: 1, succeeded: 1, failed: 0 };
  },
}));

jest.mock("../tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: (...args: unknown[]) => mockRunInNewTenantTransaction(...args),
  runInTenantTransaction: (db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(db),
}));

/** The id the request was served under. Uuid-shaped, because the outbox column is one. */
const REQUEST_ID = "1c5a3f90-7b21-4d64-9a55-2e8c0f6b41d7";
/** What the cron tick that later picks the work up is running under. */
const TICK_ID = "9e0d4a21-3c77-4f18-8b2a-6d51907cb3fe";
const EVENT_ID = "5a2e7c11-4488-4c9a-b3d1-72f6e0a95c84";

function requestContext<T>(fn: () => T): T {
  return runWithObservabilityContext(
    { correlationId: REQUEST_ID, orgId: "org-1", method: "POST", route: "/deals/:id/close" },
    fn,
  );
}

function tickContext<T>(fn: () => T): T {
  return runWithObservabilityContext(
    { correlationId: TICK_ID, route: "/cron/workflow-tick" },
    fn,
  );
}

/**
 * The hop this whole seam exists for.
 *
 * One user intent crosses four process boundaries here: a request writes an
 * outbox row, a relay turns it into a workflow run, a claim picks the run up and
 * a drain executes its steps — the last three on a cron tick that has its own
 * correlation id and knows nothing about the request. Every one of those is a
 * place the trace can be dropped, and dropping it costs nothing visible: the
 * logs stay perfectly structured, they just describe four unrelated things.
 *
 * So each assertion below is the same one twice over — that the id observed is
 * the request's, *and* that it is not the tick's. Only the second half catches
 * the failure that actually happens, which is a consumer that inherits whatever
 * ambient context it happens to be running inside.
 */
describe("correlation across the enqueue → consume hop", () => {
  afterEach(() => {
    jest.clearAllMocks();
    resetSpanExporter();
  });

  it("persists the request's correlation id on the outbox row", async () => {
    const values = jest.fn().mockResolvedValue(undefined);
    const tx = { insert: () => ({ values }) } as never;

    await requestContext(() =>
      OutboxWriter.emit(tx, {
        eventId: EVENT_ID,
        organizationId: "org-1",
        aggregateType: "deal",
        aggregateId: "deal-1",
        aggregateVersion: 1,
        eventType: "deal.closed",
        payload: {},
        occurredAt: new Date("2026-09-01T00:00:00.000Z"),
      }),
    );

    expect(values).toHaveBeenCalledTimes(1);
    expect(values.mock.calls[0]?.[0]).toMatchObject({ correlationId: REQUEST_ID });
  });

  it("relays the row under the request's id, not the tick's", async () => {
    const observed: (string | undefined)[] = [];
    const carried: (string | null | undefined)[] = [];

    const registry = new WorkflowRegistry();
    registry.register({ name: "close-deal", triggers: ["deal.closed"], handler: async () => null });

    const runner = {
      start: async (input: { correlationId?: string | null }): Promise<string> => {
        observed.push(getObservabilityContext()?.correlationId);
        carried.push(input.correlationId);
        return "run-1";
      },
    } as unknown as WorkflowRunnerService;

    const chain = {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: async () => [
        {
          outboxEventId: 1,
          eventId: EVENT_ID,
          organizationId: "org-1",
          eventType: "deal.closed",
          payload: {},
          correlationId: REQUEST_ID,
        },
      ],
    };
    const db = { select: () => chain } as unknown as Db;

    await tickContext(() => new WorkflowOutboxRelayService(db, registry, runner).relay());

    expect(observed).toEqual([REQUEST_ID]);
    expect(observed).not.toContain(TICK_ID);
    expect(carried).toEqual([REQUEST_ID]);
  });

  it("writes the relayed id onto the workflow run", async () => {
    const returning = jest.fn().mockResolvedValue([{ workflowRunId: "run-1" }]);
    const onConflictDoNothing = jest.fn().mockReturnValue({ returning });
    const values = jest.fn().mockReturnValue({ onConflictDoNothing });
    const db = { insert: () => ({ values }) } as unknown as Db;

    await startRun(db, {
      organizationId: "org-1",
      workflowName: "close-deal",
      input: {},
      correlationId: REQUEST_ID,
      causationEventId: EVENT_ID,
    });

    expect(values.mock.calls[0]?.[0]).toMatchObject({ correlationId: REQUEST_ID });
  });

  /**
   * The projection is the load-bearing half. A column written by the producer and
   * left out of the consumer's `RETURNING` is indistinguishable from never having
   * been written at all — the run executes, the logs look fine, and the join key
   * was dropped in the one query that could have carried it.
   */
  it("claims the persisted id back with the run", async () => {
    const db = {
      execute: async () => [
        {
          workflow_run_id: "run-1",
          organization_id: "org-1",
          workflow_name: "close-deal",
          input: {},
          attempt: 0,
          max_attempts: 5,
          correlation_id: REQUEST_ID,
        },
      ],
    } as unknown as Db;

    const [run] = await claimDueRuns(db, 10);

    expect(run?.correlationId).toBe(REQUEST_ID);
  });

  it("executes the run's steps under the request's id while the tick carries its own", async () => {
    const spans: FinishedSpan[] = [];
    setSpanExporter({ export: (span) => spans.push(span) });
    mockRunInNewTenantTransaction.mockImplementation(
      async (_db: unknown, _orgId: string, fn: () => Promise<unknown>) => fn(),
    );

    const seenInHandler: (string | undefined)[] = [];
    const seenInStep: (string | undefined)[] = [];

    const registry = new WorkflowRegistry();
    registry.register({
      name: "close-deal",
      handler: async (step) => {
        seenInHandler.push(getObservabilityContext()?.correlationId);
        await step.run("notify", async () => {
          seenInStep.push(getObservabilityContext()?.correlationId);
          return null;
        });
        return null;
      },
    });

    const chain = {
      from: () => chain,
      where: () => chain,
      orderBy: async () => [],
      values: () => chain,
      onConflictDoUpdate: async () => undefined,
      set: () => chain,
      returning: async () => [{ workflowRunId: "run-1" }],
    };
    const db = {
      execute: async () => [
        {
          workflow_run_id: "run-1",
          organization_id: "org-1",
          workflow_name: "close-deal",
          input: {},
          attempt: 0,
          max_attempts: 5,
          correlation_id: REQUEST_ID,
          lease_expires_at: new Date("2026-01-01T00:00:00.000Z"),
        },
      ],
      select: () => chain,
      insert: () => chain,
      update: () => chain,
    } as unknown as Db;

    const result = await tickContext(() =>
      new WorkflowRunnerService(db, registry).drain(1),
    );

    expect(result).toEqual({
      claimed: 1,
      outcomes: { completed: 1, suspended: 0, retry: 0, "dead-lettered": 0 },
    });
    expect(seenInHandler).toEqual([REQUEST_ID]);
    expect(seenInStep).toEqual([REQUEST_ID]);
    expect(seenInHandler).not.toContain(TICK_ID);

    const runSpan = spans.find((span) => span.name === "workflow.run");
    expect(runSpan?.attributes["correlation.id"]).toBe(REQUEST_ID);
    expect(runSpan?.attributes["org.id"]).toBe("org-1");
  });

  /**
   * A row written before the producer carried the id has nothing to join back to.
   * It must still get an id of its own — the drain's own lines have to group
   * together — but it must never silently adopt the tick's, which would assert a
   * link to a sweep that did not cause it.
   */
  it("mints a fresh id for a legacy run rather than borrowing the tick's", async () => {
    mockRunInNewTenantTransaction.mockImplementation(
      async (_db: unknown, _orgId: string, fn: () => Promise<unknown>) => fn(),
    );

    const seen: (string | undefined)[] = [];
    const registry = new WorkflowRegistry();
    registry.register({
      name: "close-deal",
      handler: async () => {
        seen.push(getObservabilityContext()?.correlationId);
        return null;
      },
    });

    const chain = {
      from: () => chain,
      where: () => chain,
      orderBy: async () => [],
      values: () => chain,
      onConflictDoUpdate: async () => undefined,
      set: () => chain,
      returning: async () => [{ workflowRunId: "run-1" }],
    };
    const db = {
      execute: async () => [
        {
          workflow_run_id: "run-1",
          organization_id: "org-1",
          workflow_name: "close-deal",
          input: {},
          attempt: 0,
          max_attempts: 5,
          correlation_id: null,
          lease_expires_at: new Date("2026-01-01T00:00:00.000Z"),
        },
      ],
      select: () => chain,
      insert: () => chain,
      update: () => chain,
    } as unknown as Db;

    await tickContext(() => new WorkflowRunnerService(db, registry).drain(1));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeDefined();
    expect(seen[0]).not.toBe(TICK_ID);
  });
});
