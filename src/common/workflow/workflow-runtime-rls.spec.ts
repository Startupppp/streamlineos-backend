import type { Db } from "../../db/drizzle.types";
import type { TenantTx } from "../tenant";
import { WorkflowRegistry } from "./workflow-registry";
import { WorkflowOutboxRelayService } from "./workflow-outbox-relay.service";
import type { WorkflowRunnerService } from "./workflow-runner.service";
import { claimDueRuns, createLifecycleStore, createStepStore, startRun } from "./workflow-store";

/**
 * The durable workflow runtime, driven against a database that fails closed the
 * way the real one does.
 *
 * `0208_workflow_runtime` created `workflow_runs` and `workflow_steps` outside
 * row-level security, and `workflow-store.ts` said so in its header comment: a
 * worker claims across every organisation, so a tenant policy "would make the
 * claim query return nothing". `0591_tenant_isolation_for_unprotected_tables`
 * then enabled RLS on both tables — and on `outbox_events` — with the standard
 * `organization_id = app.current_org_id()` policy. Nothing in the runtime
 * changed to match.
 *
 * The result was worse than returning nothing. `app.current_org_id()` RAISEs
 * when the tenant GUC is unset rather than returning NULL, so as the application
 * role every statement the runtime issued threw. Measured against the seeded
 * database as the non-owner `streamline_app` role:
 *
 *     select count(*) from outbox_events;
 *     ERROR:  no tenant context: app.organization_id is not set for this transaction
 *
 * `CronWorkflowService.tick()` calls `relay()` before `drain()` and guards
 * neither, so the throw took out the whole tick: `POST /cron/workflow-tick`
 * answered 500 and **nothing durable advanced** — no relayed event, no claimed
 * run, no step. It survived CI because CI connects as the database owner, which
 * has BYPASSRLS and makes every policy inert.
 *
 * So these tests do not assert on SQL text. They give the runtime a database
 * that throws the real message unless the statement is issued inside a tenant
 * scope, which is the property that actually failed. A statement that escapes
 * its tenant scope fails the test with the same error Postgres produced.
 */

/** Set while a tenant scope is open, exactly as the GUC is. */
let tenantScope: string | null = null;

const RLS_DENIAL = "no tenant context: app.organization_id is not set for this transaction";

/**
 * A database that answers only inside a tenant scope.
 *
 * Every verb the runtime uses is wired, and each checks `tenantScope` before
 * returning rows — so the double denies for the same reason the policy does
 * rather than by matching on the query.
 */
function failClosedDb(rows: Record<string, unknown>[] = []): Db {
  const guard = () => {
    if (tenantScope === null) throw new Error(RLS_DENIAL);
  };

  const chain: Record<string, unknown> = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => {
      guard();
      return rows;
    },
    values: () => chain,
    set: () => chain,
    onConflictDoNothing: () => chain,
    onConflictDoUpdate: async () => {
      guard();
    },
    returning: async () => {
      guard();
      return rows;
    },
    then: undefined,
  };

  return {
    select: () => chain,
    insert: () => chain,
    update: () => chain,
    execute: async () => {
      guard();
      return rows;
    },
  } as unknown as Db;
}

/** Opens a tenant scope around the callback, as `withTenant` does with the GUC. */
async function inScope<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  const previous = tenantScope;
  tenantScope = orgId;
  try {
    return await fn();
  } finally {
    tenantScope = previous;
  }
}

const mockForEachOrg = jest.fn();

jest.mock("../tenant", () => ({
  forEachOrg: (...args: unknown[]) => mockForEachOrg(...args),
}));

jest.mock("../tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: (db: unknown, orgId: string, fn: (tx: unknown) => Promise<unknown>) =>
    inScope(orgId, () => fn(db)),
  runInTenantTransaction: (
    db: unknown,
    fn: (tx: unknown) => Promise<unknown>,
    explicit?: { orgId: string },
  ) => inScope(explicit?.orgId ?? "org-1", () => fn(db)),
}));

/** Sweeps two organisations, opening each one's scope as `forEachOrg` does. */
function sweepingForEachOrg(orgIds = ["org-1", "org-2"]) {
  return mockForEachOrg.mockImplementation(
    async (db: unknown, _sweep: string, fn: (tx: TenantTx, orgId: string) => Promise<void>) => {
      for (const orgId of orgIds) await inScope(orgId, () => fn(db as TenantTx, orgId));
      return { organizations: orgIds.length, succeeded: orgIds.length, failed: 0 };
    },
  );
}

/**
 * The pre-fix behaviour: no scope is ever opened, so the callback runs against
 * the bare connection. This is what makes the assertions below bite — without
 * it they would pass against a double that never denies anything.
 */
function unscopedForEachOrg(orgIds = ["org-1"]) {
  return mockForEachOrg.mockImplementation(
    async (db: unknown, _sweep: string, fn: (tx: TenantTx, orgId: string) => Promise<void>) => {
      for (const orgId of orgIds) await fn(db as TenantTx, orgId);
      return { organizations: orgIds.length, succeeded: orgIds.length, failed: 0 };
    },
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  tenantScope = null;
});

describe("the workflow runtime under row-level security", () => {
  const runRow = {
    workflow_run_id: "run-1",
    organization_id: "org-1",
    workflow_name: "onboard",
    input: {},
    attempt: 0,
    max_attempts: 5,
    correlation_id: null,
  };

  describe("the relay", () => {
    const eventRow = {
      outboxEventId: 1,
      eventId: "evt-1",
      organizationId: "org-1",
      eventType: "party.created",
      payload: {},
      correlationId: null,
    };

    function relayService(db: Db) {
      const registry = new WorkflowRegistry();
      registry.register({
        name: "onboard",
        triggers: ["party.created"],
        handler: async () => null,
      });
      const runner = {
        start: async (): Promise<string> => "run-1",
      } as unknown as WorkflowRunnerService;
      return new WorkflowOutboxRelayService(db, registry, runner);
    }

    it("reads the outbox inside a tenant scope, so the tick is not denied", async () => {
      sweepingForEachOrg(["org-1"]);

      const result = await relayService(failClosedDb([eventRow])).relay();

      expect(result).toEqual({ scanned: 1, started: 1 });
    });

    /**
     * The bite proof. Remove the tenant scope and the exact production failure
     * comes back, which is what shows the assertion above is load-bearing
     * rather than passing against a permissive double.
     */
    it("is denied when the read escapes its tenant scope — the shipped defect", async () => {
      unscopedForEachOrg();

      await expect(relayService(failClosedDb([eventRow])).relay()).rejects.toThrow(RLS_DENIAL);
    });

    /**
     * One cursor shared across tenants was lossy even as the owner: the ids come
     * from one global sequence, so a busy tenant's events dragged the cursor past
     * a quiet tenant's lower-numbered ones, which were then never read. Each
     * organisation keeps its own position.
     */
    it("keeps a separate cursor per organisation", async () => {
      mockForEachOrg.mockImplementation(
        async (db: unknown, _sweep: string, fn: (tx: TenantTx, orgId: string) => Promise<void>) => {
          await inScope("org-loud", () => fn(db as TenantTx, "org-loud"));
          await inScope("org-quiet", () => fn(db as TenantTx, "org-quiet"));
          return { organizations: 2, succeeded: 2, failed: 0 };
        },
      );

      const relay = relayService(
        failClosedDb([{ ...eventRow, outboxEventId: 9_000, organizationId: "org-loud" }]),
      );
      await relay.relay();

      // The loud tenant advanced; the quiet one is untouched by its neighbour.
      expect(relay.positionFor("org-loud")).toBe(8_000);
      expect(relay.positionFor("org-quiet")).toBe(0);
    });
  });

  describe("the claim", () => {
    it("claims due runs inside a tenant scope", async () => {
      sweepingForEachOrg(["org-1"]);

      const claimed = await claimDueRuns(failClosedDb([runRow]), 10);

      expect(claimed).toHaveLength(1);
      expect(claimed[0]?.organizationId).toBe("org-1");
    });

    it("is denied when the claim escapes its tenant scope — the shipped defect", async () => {
      unscopedForEachOrg();

      await expect(claimDueRuns(failClosedDb([runRow]), 10)).rejects.toThrow(RLS_DENIAL);
    });

    /**
     * The batch limit is a budget spent across organisations, not granted to
     * each one. Per-organisation it would let one busy tenant multiply the
     * tick's work by the tenant count.
     */
    it("spends the batch limit across organisations rather than per organisation", async () => {
      const limits: unknown[] = [];
      mockForEachOrg.mockImplementation(
        async (_db: unknown, _sweep: string, fn: (tx: TenantTx, orgId: string) => Promise<void>) => {
          for (const orgId of ["org-1", "org-2", "org-3"])
            await inScope(orgId, () =>
              fn(
                {
                  execute: async (query: unknown) => {
                    limits.push(query);
                    return [{ ...runRow, organization_id: orgId }];
                  },
                } as unknown as TenantTx,
                orgId,
              ),
            );
          return { organizations: 3, succeeded: 3, failed: 0 };
        },
      );

      const claimed = await claimDueRuns(failClosedDb(), 2);

      // Two organisations filled the budget; the third was never queried.
      expect(claimed).toHaveLength(2);
      expect(limits).toHaveLength(2);
    });
  });

  describe("starting a run", () => {
    it("inserts inside the run's own tenant scope", async () => {
      const runId = await startRun(failClosedDb([{ workflowRunId: "run-1" }]), {
        organizationId: "org-1",
        workflowName: "onboard",
        input: {},
      });

      expect(runId).toBe("run-1");
    });
  });

  describe("the run's own writes", () => {
    /**
     * Every lifecycle write happens after `withinStep`'s transaction has closed
     * — `workflow-runner.ts` calls `complete`, `retry` and `deadLetter` outside
     * it — so each needs a scope of its own. Left bare, a run executed its steps
     * and then threw on the write that records it finished, which is the shape
     * that repeats work on the next tick.
     */
    it("records a terminal status inside a tenant scope", async () => {
      const lifecycle = createLifecycleStore(failClosedDb(), "org-1");

      await expect(lifecycle.complete("run-1", null, new Date())).resolves.toBeUndefined();
      await expect(
        lifecycle.deadLetter("run-1", 5, "budget exhausted", new Date()),
      ).resolves.toBeUndefined();
    });

    it("records a step inside a tenant scope", async () => {
      const steps = createStepStore(failClosedDb(), "org-1");

      await expect(
        steps.recordStep({
          runId: "run-1",
          organizationId: "org-1",
          stepName: "notify",
          status: "COMPLETED",
          output: null,
          error: null,
          attempt: 0,
        }),
      ).resolves.toBeUndefined();
    });
  });
});
