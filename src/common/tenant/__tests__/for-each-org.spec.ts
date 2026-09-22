import type { SQL } from "drizzle-orm";
import { forEachOrg } from "../for-each-org";
import { getTenantContext, registerAfterCommit } from "../tenant-context";
import { observeAfterCommitWork } from "../../observability/after-commit-work";
import {
  getObservabilityContext,
  runWithObservabilityContext,
} from "../../observability/observability-context";
import { logger } from "../../logger/logger.service";
import type { Db } from "../../../db/drizzle.module";
import {
  clearRegionRegistry,
  setRegionRegistry,
  type RegionRegistry,
} from "../../region/region-registry";

interface ChainCapture {
  where?: SQL;
}

function collectColumnNames(value: unknown, found: Set<string>): void {
  if (value === null || typeof value !== "object") return;
  if ("name" in value && typeof (value as { name: unknown }).name === "string") {
    found.add((value as { name: string }).name);
  }
  if ("queryChunks" in value && Array.isArray((value as { queryChunks: unknown[] }).queryChunks)) {
    for (const chunk of (value as { queryChunks: unknown[] }).queryChunks) {
      collectColumnNames(chunk, found);
    }
  }
}

function makeMockDb(orgIds: string[]): { db: Db; capture: ChainCapture; execute: jest.Mock } {
  const capture: ChainCapture = {};
  const execute = jest.fn();
  const rows = orgIds.map((id) => ({ id }));

  interface SelectChain {
    from: jest.Mock<SelectChain, []>;
    where: jest.Mock<SelectChain, [SQL]>;
    orderBy: jest.Mock<SelectChain, []>;
    limit: jest.Mock<Promise<{ id: string }[]>, [number]>;
  }

  let drained = 0;
  const chain: SelectChain = {
    from: jest.fn((): SelectChain => chain),
    where: jest.fn((condition: SQL): SelectChain => {
      capture.where = condition;
      return chain;
    }),
    orderBy: jest.fn((): SelectChain => chain),
    limit: jest.fn((pageSize: number) => {
      const page = rows.slice(drained, drained + pageSize);
      drained += page.length;
      return Promise.resolve(page);
    }),
  };

  const db = {
    select: jest.fn(() => chain),
    transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn({ execute })),
  };

  return { db: db as unknown as Db, capture, execute };
}

describe("forEachOrg", () => {
  it("only enumerates organizations that are ACTIVE, placed, and not soft-deleted", async () => {
    const { db, capture } = makeMockDb([]);

    await forEachOrg(db, "test-sweep", jest.fn());

    const columns = new Set<string>();
    collectColumnNames(capture.where, columns);
    expect(columns).toContain("status");
    expect(columns).toContain("deleted_at");
    expect(columns).toContain("region");
  });

  it("runs the callback once per organization with that organization's id", async () => {
    const { db } = makeMockDb(["org-a", "org-b", "org-c"]);
    const seen: string[] = [];

    const result = await forEachOrg(db, "test-sweep", async (_tx, orgId) => {
      seen.push(orgId);
    });

    expect(seen).toEqual(["org-a", "org-b", "org-c"]);
    expect(result).toEqual({ organizations: 3, succeeded: 3, failed: 0 });
  });

  it("sets the tenant GUC for each organization", async () => {
    const { db, execute } = makeMockDb(["org-a", "org-b"]);

    await forEachOrg(db, "test-sweep", jest.fn());

    expect(execute).toHaveBeenCalledTimes(2);
    const orgIds = new Set<string>();
    function collectNestedStrings(value: unknown): void {
      if (typeof value === "string") { orgIds.add(value); return; }
      if (!value || typeof value !== "object") return;
      const obj = value as Record<string, unknown>;
      if ("queryChunks" in obj && Array.isArray(obj.queryChunks))
        for (const c of obj.queryChunks as unknown[]) collectNestedStrings(c);
    }
    for (const call of execute.mock.calls) collectNestedStrings(call[0]);
    expect(orgIds).toContain("org-a");
    expect(orgIds).toContain("org-b");
  });

  it("exposes the ambient tenant context so nested services resolve to the transaction", async () => {
    const { db } = makeMockDb(["org-a"]);
    let observed: string | undefined;

    await forEachOrg(db, "test-sweep", async () => {
      observed = getTenantContext()?.orgId;
    });

    expect(observed).toBe("org-a");
  });

  it("carries an after-commit queue, so deferred work runs after the organisation's transaction and not inside it", async () => {
    /*
     * Without the queue `registerAfterCommit` answers false inside a sweep and
     * a service falls back to running the work inline — an email sent before
     * the token it links to is durable. With it, the hook is accepted and
     * drained once the organisation's transaction has returned.
     */
    const { db } = makeMockDb(["org-a"]);
    const completions: Promise<unknown>[] = [];
    const stop = observeAfterCommitWork((completion) => completions.push(completion));
    const order: string[] = [];
    let accepted: boolean | undefined;

    try {
      await forEachOrg(db, "test-sweep", async () => {
        accepted = registerAfterCommit(async () => {
          order.push("hook");
        });
        order.push("body");
      });
      await Promise.all(completions);
    } finally {
      stop();
    }

    expect(accepted).toBe(true);
    expect(order).toEqual(["body", "hook"]);
  });

  it("isolates a failing organization and continues the sweep", async () => {
    const { db } = makeMockDb(["org-a", "org-b", "org-c"]);
    const seen: string[] = [];

    const result = await forEachOrg(db, "test-sweep", async (_tx, orgId) => {
      seen.push(orgId);
      if (orgId === "org-b") throw new Error("boom");
    });

    expect(seen).toEqual(["org-a", "org-b", "org-c"]);
    expect(result).toEqual({ organizations: 3, succeeded: 2, failed: 1 });
  });

  it("leaves no tenant context behind once the sweep finishes", async () => {
    const { db } = makeMockDb(["org-a"]);

    await forEachOrg(db, "test-sweep", jest.fn());

    expect(getTenantContext()).toBeUndefined();
  });
});

/**
 * Ascending-id enumeration with a per-tick budget is a starvation machine: the
 * lowest org id gets first refusal on every tick forever. Rotation is what makes
 * "every tenant is reached within N ticks" true instead of "eventually, maybe".
 */
describe("forEachOrg — rotation makes the sweep resumable", () => {
  it("starts at the organization after the cursor and wraps around to the ones before it", async () => {
    const { db } = makeMockDb(["org-a", "org-b", "org-c", "org-d"]);
    const seen: string[] = [];

    const result = await forEachOrg(
      db,
      "test-sweep",
      async (_tx, orgId) => { seen.push(orgId); },
      "write",
      { startAfterOrgId: "org-b" },
    );

    expect(seen).toEqual(["org-c", "org-d", "org-a", "org-b"]);
    expect(result).toEqual({ organizations: 4, succeeded: 4, failed: 0 });
  });

  it("wraps to the lowest id when the cursor is at or past the highest", async () => {
    const { db } = makeMockDb(["org-a", "org-b", "org-c"]);
    const seen: string[] = [];

    await forEachOrg(
      db,
      "test-sweep",
      async (_tx, orgId) => { seen.push(orgId); },
      "write",
      { startAfterOrgId: "org-z" },
    );

    expect(seen).toEqual(["org-a", "org-b", "org-c"]);
  });

  it("enumerates in plain ascending order when no cursor is given", async () => {
    const { db } = makeMockDb(["org-a", "org-b", "org-c"]);
    const seen: string[] = [];

    await forEachOrg(
      db,
      "test-sweep",
      async (_tx, orgId) => { seen.push(orgId); },
      "write",
      { startAfterOrgId: null },
    );

    expect(seen).toEqual(["org-a", "org-b", "org-c"]);
  });
});

describe("forEachOrg — the enumeration drains every page, not just the first", () => {
  const pageSize = 500;

  it("visits organizations past the first page", async () => {
    const orgIds = Array.from({ length: pageSize + 137 }, (_, i) => `org-${String(i).padStart(4, "0")}`);
    const { db } = makeMockDb(orgIds);
    const seen: string[] = [];

    const result = await forEachOrg(db, "test-sweep", async (_tx, orgId) => { seen.push(orgId); });

    expect(seen).toHaveLength(orgIds.length);
    expect(seen[0]).toBe(orgIds[0]);
    expect(seen[seen.length - 1]).toBe(orgIds[orgIds.length - 1]);
    expect(result.organizations).toBe(orgIds.length);
  });

  it("asks for one more page when the last one came back exactly full", async () => {
    const orgIds = Array.from({ length: pageSize }, (_, i) => `org-${String(i).padStart(4, "0")}`);
    const { db } = makeMockDb(orgIds);
    const seen: string[] = [];

    await forEachOrg(db, "test-sweep", async (_tx, orgId) => { seen.push(orgId); });

    expect(seen).toHaveLength(pageSize);
    expect(new Set(seen).size).toBe(pageSize);
  });
});

describe("forEachOrg — stopWhen bounds the fanout", () => {
  it("stops before opening the next organization's transaction, not merely before its work", async () => {
    const { db, execute } = makeMockDb(["org-a", "org-b", "org-c", "org-d"]);
    const seen: string[] = [];

    const result = await forEachOrg(
      db,
      "test-sweep",
      async (_tx, orgId) => { seen.push(orgId); },
      "write",
      { stopWhen: () => seen.length >= 2 },
    );

    expect(seen).toEqual(["org-a", "org-b"]);
    // The GUC statement is the first thing inside withTenant's transaction, so
    // its call count is the number of transactions actually opened.
    expect(execute).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ organizations: 2, succeeded: 2, failed: 0 });
  });

  it("visits every organization when stopWhen never fires", async () => {
    const { db, execute } = makeMockDb(["org-a", "org-b", "org-c"]);

    const result = await forEachOrg(
      db,
      "test-sweep",
      jest.fn(),
      "write",
      { stopWhen: () => false },
    );

    expect(execute).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ organizations: 3, succeeded: 3, failed: 0 });
  });
});

describe("forEachOrg — cell-aware enumeration", () => {
  const savedCellId = process.env.CELL_ID;

  afterEach(() => {
    clearRegionRegistry();
    if (savedCellId === undefined) delete process.env.CELL_ID;
    else process.env.CELL_ID = savedCellId;
  });

  function makeRegistryWithCells(
    fallbackDb: Db,
    cellDb: Db,
    activeCellId = "cell-2",
  ): RegionRegistry {
    const placement = (orgId: string) => ({
      organizationId: orgId,
      region: activeCellId === "cell-2" ? "cell-2" : "primary",
      cellId: activeCellId,
      databaseShard: activeCellId,
      objectStorageRegion: "auto",
      searchCluster: activeCellId,
      placementVersion: 1,
      writeFenceToken: null,
      leaseExpiresAt: null,
      status: "ACTIVE" as const,
    });
    return {
      keys: ["primary", "cell-2"],
      bindingFor: (key: string): ReturnType<RegionRegistry["bindingFor"]> => ({
        definition: {
          cell: { cellId: key === "cell-2" ? "cell-2" : "legacy-1" },
        } as ReturnType<RegionRegistry["bindingFor"]>["definition"],
        db: key === "cell-2" ? cellDb : fallbackDb,
      }),
      admittedPlacementForOrg: async (orgId: string) => placement(orgId),
    } as unknown as RegionRegistry;
  }

  it("uses the cell-specific db when CELL_ID is set and a registry is available", async () => {
    const fallbackDb = makeMockDb([]).db;
    const { db: cellDb, capture } = makeMockDb(["org-cell-2-a", "org-cell-2-b"]);

    process.env.CELL_ID = "cell-2";
    setRegionRegistry(makeRegistryWithCells(fallbackDb, cellDb));

    const seen: string[] = [];
    const result = await forEachOrg(fallbackDb, "cell-sweep", async (_tx, orgId) => {
      seen.push(orgId);
    });

    expect(seen).toEqual(["org-cell-2-a", "org-cell-2-b"]);
    expect(result.organizations).toBe(2);
    expect(capture.where).toBeDefined();
  });

  it("uses the fallback db when CELL_ID is not set (single-cell deployment)", async () => {
    delete process.env.CELL_ID;
    const { db: fallbackDb, capture } = makeMockDb(["org-primary-a"]);
    const cellDb = makeMockDb([]).db;

    setRegionRegistry(makeRegistryWithCells(fallbackDb, cellDb, "legacy-1"));

    const seen: string[] = [];
    await forEachOrg(fallbackDb, "primary-sweep", async (_tx, orgId) => {
      seen.push(orgId);
    });

    expect(seen).toEqual(["org-primary-a"]);
    expect(capture.where).toBeDefined();
  });

  it("uses the fallback db when no registry is configured (unit-test path)", async () => {
    process.env.CELL_ID = "cell-2";

    const { db: fallbackDb, capture } = makeMockDb(["org-from-fallback"]);

    const seen: string[] = [];
    await forEachOrg(fallbackDb, "no-registry-sweep", async (_tx, orgId) => {
      seen.push(orgId);
    });

    expect(seen).toEqual(["org-from-fallback"]);
    expect(capture.where).toBeDefined();
  });

  it("OUTAGE PROBE — cell-1 db faulted, cell-2 sweep is unaffected", async () => {
    const faultedDb = makeMockDb([]).db;

    const cell2Orgs = ["org-cell-2-x", "org-cell-2-y"];
    const { db: cell2Db } = makeMockDb(cell2Orgs);

    process.env.CELL_ID = "cell-2";
    setRegionRegistry(makeRegistryWithCells(faultedDb, cell2Db));

    const seen: string[] = [];
    const result = await forEachOrg(faultedDb, "outage-probe", async (_tx, orgId) => {
      seen.push(orgId);
    });

    expect(seen).toEqual(cell2Orgs);
    expect(result.organizations).toBe(2);
    expect(result.failed).toBe(0);
  });

  it("OUTAGE PROBE bites — cell-2 db faulted, cell-2 sweep returns 0 orgs", async () => {
    const faultedCell2Db = makeMockDb([]).db;
    const { db: cell1Db } = makeMockDb(["org-cell-1-a", "org-cell-1-b"]);

    process.env.CELL_ID = "cell-2";
    setRegionRegistry(makeRegistryWithCells(cell1Db, faultedCell2Db));

    const seen: string[] = [];
    const result = await forEachOrg(cell1Db, "outage-probe-bites", async (_tx, orgId) => {
      seen.push(orgId);
    });

    expect(seen).toEqual([]);
    expect(result.organizations).toBe(0);
  });
});

describe("forEachOrg — background work states its tenant in the log context", () => {
  it("names the organisation on every line the callback emits, not only in the caller's meta", async () => {
    const { db } = makeMockDb(["org-a", "org-b"]);
    const lines: Record<string, unknown>[] = [];
    const spy = jest.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      lines.push(JSON.parse(String(chunk)) as Record<string, unknown>);
      return true;
    });

    try {
      await forEachOrg(db, "retention-sweep", async () => {
        logger.info("purged a batch");
      });
    } finally {
      spy.mockRestore();
    }

    expect(lines.map((line) => line["orgId"])).toEqual(["org-a", "org-b"]);
    expect(lines.every((line) => line["route"] === "sweep:retention-sweep")).toBe(true);
  });

  it("carries the triggering request's correlation id through, so the sweep joins its cron call", async () => {
    const { db } = makeMockDb(["org-a", "org-b"]);
    const seen: (string | undefined)[] = [];

    await runWithObservabilityContext(
      { correlationId: "cid-cron-tick", route: "/cron/retention", method: "POST" },
      () =>
        forEachOrg(db, "retention-sweep", async () => {
          seen.push(getObservabilityContext()?.correlationId);
        }),
    );

    expect(seen).toEqual(["cid-cron-tick", "cid-cron-tick"]);
  });

  it("(bite proof) the ambient context is not mutated — the caller's orgId survives the sweep", async () => {
    const { db } = makeMockDb(["org-a"]);

    await runWithObservabilityContext(
      { correlationId: "cid-cron-tick", orgId: "org-trigger" },
      async () => {
        await forEachOrg(db, "retention-sweep", async () => undefined);
        expect(getObservabilityContext()?.orgId).toBe("org-trigger");
      },
    );
  });

  it("a failed organization's error line carries that organization at the top level", async () => {
    const { db } = makeMockDb(["org-a"]);
    const lines: Record<string, unknown>[] = [];
    const spy = jest.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      lines.push(JSON.parse(String(chunk)) as Record<string, unknown>);
      return true;
    });

    let result;
    try {
      result = await forEachOrg(db, "retention-sweep", async () => {
        throw new Error("boom");
      });
    } finally {
      spy.mockRestore();
    }

    expect(result).toMatchObject({ organizations: 1, succeeded: 0, failed: 1 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ orgId: "org-a", route: "sweep:retention-sweep" });
  });
});

describe("forEachOrg — a dropped connection is not a defect in the sweep", () => {
  afterEach(() => jest.restoreAllMocks());

  // The production line this was written from, 2026-09-21T14:24:07Z:
  //   [notification-delivery-claim] organization sweep failed
  //   write CONNECTION_ENDED streamlineos-instance-1...ap-south-1.rds.amazonaws.com:5432
  // No `cause` and no `code` reached the log, so the classifier has to answer from
  // the message alone — which is the shape this fixture reproduces.
  const droppedSocket = (): Error => new Error("write CONNECTION_ENDED db.example:5432");

  it("warns once for the whole run rather than raising an error per organisation, because one blip breaks every remaining org on the same pool connection", async () => {
    const { db } = makeMockDb(["org-a", "org-b", "org-c"]);
    const warn = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
    const error = jest.spyOn(logger, "error").mockImplementation(() => undefined);

    const result = await forEachOrg(db, "notification-delivery-claim", async () => {
      throw droppedSocket();
    });

    expect(error).not.toHaveBeenCalled();
    const firstWarn = warn.mock.calls.filter(([message]) =>
      String(message).includes("will retry next run"),
    );
    expect(firstWarn).toHaveLength(1);
    expect(result).toMatchObject({ organizations: 3, succeeded: 0, failed: 3 });
  });

  it("still counts every transient organisation as failed, so a degraded run reaches emitPartialFailure instead of reading as a pass", async () => {
    const { db } = makeMockDb(["org-a", "org-b"]);
    jest.spyOn(logger, "warn").mockImplementation(() => undefined);
    jest.spyOn(logger, "error").mockImplementation(() => undefined);

    const result = await forEachOrg(db, "notification-delivery-claim", async () => {
      throw droppedSocket();
    });

    expect(result.failed).toBe(2);
    expect(result.succeeded).toBe(0);
  });

  it("reports the collapsed count when more than one organisation hit it, so the blast radius is still legible", async () => {
    const { db } = makeMockDb(["org-a", "org-b", "org-c"]);
    const warn = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
    jest.spyOn(logger, "error").mockImplementation(() => undefined);

    await forEachOrg(db, "notification-delivery-claim", async () => {
      throw droppedSocket();
    });

    const summary = warn.mock.calls.find(([message]) =>
      String(message).includes("of 3 organisation(s) hit the same transient"),
    );
    expect(summary).toBeDefined();
  });

  it("leaves a real defect at error level, so classifying the transient class does not mute the rest", async () => {
    const { db } = makeMockDb(["org-a"]);
    const warn = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
    const error = jest.spyOn(logger, "error").mockImplementation(() => undefined);

    await forEachOrg(db, "notification-delivery-claim", async () => {
      throw new Error("null value in column \"org_id\" violates not-null constraint");
    });

    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toContain("organization sweep failed");
    expect(
      warn.mock.calls.filter(([m]) => String(m).includes("will retry next run")),
    ).toHaveLength(0);
  });
});
