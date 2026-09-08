import type { SQL } from "drizzle-orm";
import {
  forEachOrg,
  hasSweepFailureSink,
  registerSweepFailureSink,
  type SweepPartialFailure,
} from "../for-each-org";
import type { Db } from "../../../db/drizzle.module";

// ─── A per-tenant failure was a counter nobody read ──────────────────────────
//
// MECHANISM: forEachOrg isolates a failing organisation so the rest of the sweep still
// drains, then returned `{organizations, succeeded, failed}`. The route answered 200 and
// CronLeaseService wrote a success heartbeat regardless, so a tenant whose retention
// sweep threw on every tick looked exactly like one with nothing to delete.
//
// The fixtures run MORE organisations than any single page or batch these sweeps use,
// so a sink that fires only for the first failure, or only when every org fails, is
// visible rather than plausible.

const ORG_COUNT = 250;

function makeMockDb(orgIds: string[]): Db {
  interface SelectChain {
    from: jest.Mock<SelectChain, []>;
    where: jest.Mock<SelectChain, [SQL]>;
    orderBy: jest.Mock<SelectChain, []>;
    limit: jest.Mock<Promise<{ id: string }[]>, [number]>;
  }
  const rows = orgIds.map((id) => ({ id }));
  let drained = 0;
  const chain: SelectChain = {
    from: jest.fn((): SelectChain => chain),
    where: jest.fn((_condition: SQL): SelectChain => chain),
    orderBy: jest.fn((): SelectChain => chain),
    limit: jest.fn((pageSize: number) => {
      const page = rows.slice(drained, drained + pageSize);
      drained += page.length;
      return Promise.resolve(page);
    }),
  };
  const db = {
    select: jest.fn(() => chain),
    transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn({ execute: jest.fn() })),
  };
  return db as unknown as Db;
}

function orgIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `org-${String(i + 1).padStart(4, "0")}`);
}

afterEach(() => {
  registerSweepFailureSink(null);
});

describe("forEachOrg — a partial failure becomes a durable event", () => {
  it("emits one event naming every failed tenant across a 250-organisation sweep", async () => {
    const ids = orgIds(ORG_COUNT);
    const db = makeMockDb(ids);
    const events: SweepPartialFailure[] = [];
    registerSweepFailureSink((event) => {
      events.push(event);
    });
    const failing = new Set(["org-0007", "org-0113", "org-0250"]);

    const result = await forEachOrg(db, "mail-metadata-retention", async (_tx, orgId) => {
      if (failing.has(orgId)) throw new Error(`tenant ${orgId} exploded`);
    });

    expect(result).toEqual({ organizations: ORG_COUNT, succeeded: ORG_COUNT - 3, failed: 3 });
    expect(events).toHaveLength(1);
    expect(events[0].sweep).toBe("mail-metadata-retention");
    expect(events[0].failed).toBe(3);
    expect(events[0].failedOrgIds).toEqual(["org-0007", "org-0113", "org-0250"]);
    expect(Date.parse(events[0].at)).not.toBeNaN();
  });

  it("names the LAST organisation too — the failure is not truncated to the first page", async () => {
    const ids = orgIds(ORG_COUNT);
    const db = makeMockDb(ids);
    const events: SweepPartialFailure[] = [];
    registerSweepFailureSink((event) => {
      events.push(event);
    });

    await forEachOrg(db, "helpdesk-retention", async (_tx, orgId) => {
      if (orgId === ids[ids.length - 1]) throw new Error("last tenant failed");
    });

    expect(events[0].failedOrgIds).toEqual([ids[ids.length - 1]]);
  });

  it("emits nothing when every organisation succeeds — a silent sweep must stay silent", async () => {
    const db = makeMockDb(orgIds(ORG_COUNT));
    const events: SweepPartialFailure[] = [];
    registerSweepFailureSink((event) => {
      events.push(event);
    });

    const result = await forEachOrg(db, "announcements-retention", jest.fn());

    expect(result.failed).toBe(0);
    expect(events).toEqual([]);
  });

  it("still returns the result when the sink itself throws", async () => {
    const db = makeMockDb(orgIds(10));
    registerSweepFailureSink(() => {
      throw new Error("redis down");
    });

    const result = await forEachOrg(db, "kb-chunk-retention", async (_tx, orgId) => {
      if (orgId === "org-0003") throw new Error("boom");
    });

    expect(result).toEqual({ organizations: 10, succeeded: 9, failed: 1 });
  });

  it("waits for an async sink before the sweep returns — a fire-and-forget write can be lost", async () => {
    const db = makeMockDb(orgIds(10));
    let settled = false;
    registerSweepFailureSink(async () => {
      await Promise.resolve();
      settled = true;
    });

    await forEachOrg(db, "hr-policy-retention", async (_tx, orgId) => {
      if (orgId === "org-0001") throw new Error("boom");
    });

    expect(settled).toBe(true);
  });

  it("reports whether a sink is installed at all", () => {
    expect(hasSweepFailureSink()).toBe(false);
    registerSweepFailureSink(() => undefined);
    expect(hasSweepFailureSink()).toBe(true);
    registerSweepFailureSink(null);
    expect(hasSweepFailureSink()).toBe(false);
  });
});
