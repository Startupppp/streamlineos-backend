import { drainBacklog } from "./workflow-store";
import type { Db } from "../../db/drizzle.module";
import type { TenantTx } from "../tenant";

const mockForEachOrg = jest.fn();

jest.mock("../tenant", () => ({
  forEachOrg: (...args: unknown[]) => mockForEachOrg(...args),
}));

/**
 * The check that turns a silent failure into a visible one.
 *
 * The workflow runtime does not schedule itself — deliberately, so that one
 * place decides how often background work runs. The cost of that decision is a
 * total dependency on something outside calling `/cron/workflow-tick`, and
 * nothing in this repository does: no in-process scheduler, no `vercel.json`,
 * nothing under `.github/`.
 *
 * When that is true, a durable workflow claims nothing and runs nothing. A quote
 * waits out its hold window and never sends; an inbound message is accepted and
 * never filed. Every surface goes on reporting work in progress, because from
 * the inside "not started yet" and "never going to start" are the same row.
 *
 * `workflow_runs` on the development database currently holds **zero** rows,
 * which is what that looks like: the runtime has never executed anything.
 */
describe("drainBacklog", () => {
  /**
   * One organisation answering one `execute`, which is all this reads.
   *
   * The backlog is swept per organisation rather than counted across all of
   * them at once: `workflow_runs` carries a tenant policy and the cross-tenant
   * form is denied outright as the application role.
   */
  const dbReturning = (row: Record<string, unknown>): Db => {
    mockForEachOrg.mockImplementation(
      async (_db: unknown, _sweep: string, fn: (tx: TenantTx, orgId: string) => Promise<void>) => {
        await fn({ execute: async () => [row] } as unknown as TenantTx, "org-1");
        return { organizations: 1, succeeded: 1, failed: 0 };
      },
    );
    return {} as unknown as Db;
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  /**
   * The sum across tenants, not one tenant's number.
   *
   * A per-organisation sweep that returned only the last organisation's count
   * would report a backlog of one while thousands of runs sat due elsewhere —
   * the same invisible stall this file exists to make visible, moved one level
   * down.
   */
  it("sums the backlog across organisations and reports the oldest wait of any", async () => {
    mockForEachOrg.mockImplementation(
      async (_db: unknown, _sweep: string, fn: (tx: TenantTx, orgId: string) => Promise<void>) => {
        const rows: Record<string, Record<string, unknown>> = {
          "org-a": { due: 3, oldest: 120 },
          "org-b": { due: 4, oldest: 942 },
          "org-c": { due: 0, oldest: 0 },
        };
        for (const [orgId, row] of Object.entries(rows))
          await fn({ execute: async () => [row] } as unknown as TenantTx, orgId);
        return { organizations: 3, succeeded: 3, failed: 0 };
      },
    );

    expect(await drainBacklog({} as unknown as Db)).toEqual({ due: 7, oldestDueSeconds: 942 });
  });

  /**
   * An organisation with nothing due reports `oldest: 0`, and that zero is not a
   * wait — folding it into the maximum would report a busy queue as fresh.
   */
  it("ignores the age reported by an organisation with nothing due", async () => {
    mockForEachOrg.mockImplementation(
      async (_db: unknown, _sweep: string, fn: (tx: TenantTx, orgId: string) => Promise<void>) => {
        await fn({ execute: async () => [{ due: 0, oldest: 0 }] } as unknown as TenantTx, "org-a");
        await fn({ execute: async () => [{ due: 2, oldest: 500 }] } as unknown as TenantTx, "org-b");
        return { organizations: 2, succeeded: 2, failed: 0 };
      },
    );

    expect(await drainBacklog({} as unknown as Db)).toEqual({ due: 2, oldestDueSeconds: 500 });
  });

  it("reports nothing due when the queue is empty", async () => {
    expect(await drainBacklog(dbReturning({ due: 0, oldest: 0 }))).toEqual({
      due: 0,
      oldestDueSeconds: null,
    });
  });

  /**
   * Null rather than zero when nothing is due, because zero is a real age — a
   * run that came due this instant — and a caller alerting on "oldest > 300"
   * must not be able to read an empty queue as a fresh one.
   */
  it("distinguishes an empty queue from a run that just came due", async () => {
    const empty = await drainBacklog(dbReturning({ due: 0, oldest: 0 }));
    const fresh = await drainBacklog(dbReturning({ due: 1, oldest: 0 }));

    expect(empty.oldestDueSeconds).toBeNull();
    expect(fresh.oldestDueSeconds).toBe(0);
  });

  it("reports how long the oldest due run has been waiting", async () => {
    expect(await drainBacklog(dbReturning({ due: 7, oldest: 942 }))).toEqual({
      due: 7,
      oldestDueSeconds: 942,
    });
  });

  /**
   * Postgres hands `count(*)::int` back through the driver as a string often
   * enough that a bare `row.due` would flow a string into a numeric comparison,
   * where `"7" > 300` is false and a stall reports healthy.
   */
  it("survives the driver returning its numbers as strings", async () => {
    expect(await drainBacklog(dbReturning({ due: "7", oldest: "942" }))).toEqual({
      due: 7,
      oldestDueSeconds: 942,
    });
  });

  it("treats a row with nothing in it as an empty queue rather than throwing", async () => {
    expect(await drainBacklog(dbReturning({}))).toEqual({ due: 0, oldestDueSeconds: null });
  });
});
