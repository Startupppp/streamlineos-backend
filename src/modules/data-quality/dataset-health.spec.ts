import type { Db } from "../../db/drizzle.types";
import { dataQualityFindings, dataQualityHealthSnapshots } from "../../db/schema";
import type {
  DataQualityProducer,
  FindingSeverity,
  FindingStatus,
} from "../../db/schema/crm/data-quality";
import { SEVERITY_WEIGHTS } from "./finding-vocabulary";
import { datasetHealth, healthDirection } from "./dataset-health";
import { DataQualityHealthService } from "./dataset-health.service";
import { DataQualityResolutionService } from "./data-quality-resolution.service";
import type { DataQualityQueueService } from "./data-quality-queue.service";
import type { PartyMergeService } from "../party/party-merge.service";

/**
 * The dataset-health number, and the one claim about it worth testing.
 *
 * A health metric is trivially easy to ship broken in a way nobody notices: it
 * renders, it is plausible, and it never moves — because it counts every finding
 * ever filed, or is served from a snapshot nothing refreshes, or is recorded
 * from a schedule that no write path triggers. Any of those produces a graph
 * that looks like measurement and is decoration.
 *
 * So the second half of this file does not assert that the number *should* fall.
 * It works the queue through the real `DataQualityResolutionService` and reads
 * the number back through the real `DataQualityHealthService`, with one store
 * underneath both, and checks that it fell by exactly the weight of what was
 * closed.
 */

// ── The composite ───────────────────────────────────────────────────────────

describe("datasetHealth", () => {
  it("weights by severity rather than counting, so noise cannot outrank harm", () => {
    const noisy = datasetHealth([{ producer: "staleness", severity: "low", count: 400 }]);
    const harmful = datasetHealth([{ producer: "contradiction", severity: "high", count: 60 }]);

    // 400 stale leads are an afternoon; 60 customers whose tax numbers
    // contradict each other are invoices going to the wrong company.
    expect(noisy.openTotal).toBeGreaterThan(harmful.openTotal);
    expect(harmful.composite).toBeGreaterThan(noisy.composite);
  });

  it("decomposes the composite by class, heaviest first", () => {
    const health = datasetHealth([
      { producer: "staleness", severity: "low", count: 10 },
      { producer: "duplicate", severity: "high", count: 2 },
      { producer: "duplicate", severity: "medium", count: 1 },
      { producer: "reachability", severity: "medium", count: 2 },
    ]);

    expect(health.byClass).toEqual([
      { producer: "duplicate", count: 3, weight: 2 * 8 + 1 * 3 },
      { producer: "staleness", count: 10, weight: 10 },
      { producer: "reachability", count: 2, weight: 6 },
    ]);

    // The classes are a decomposition, not a separate calculation: they have to
    // add up to the headline or the card is telling two stories.
    expect(health.byClass.reduce((total, row) => total + row.weight, 0)).toBe(health.composite);
    expect(health.composite).toBe(19 + 10 + 6);
  });

  it("reports every severity, so a gap is never mistaken for a zero", () => {
    const health = datasetHealth([{ producer: "duplicate", severity: "high", count: 1 }]);
    expect(health.bySeverity).toEqual({ high: 1, medium: 0, low: 0 });
  });

  it("is zero for a clean dataset rather than absent", () => {
    const health = datasetHealth([]);
    expect(health).toMatchObject({ composite: 0, openTotal: 0, byClass: [] });
  });
});

describe("healthDirection", () => {
  /**
   * The composite is a penalty, so a falling number is the good news. Naming the
   * directions rather than returning a signed delta is what stops a reader
   * having to remember which way is up.
   */
  it("calls a falling composite an improvement", () => {
    expect(healthDirection(10, 40)).toBe("improving");
    expect(healthDirection(40, 10)).toBe("worsening");
    expect(healthDirection(10, 10)).toBe("unchanged");
  });

  it("has no direction at all without a point to compare against", () => {
    // "Unchanged" on a tenant whose queue was switched on this morning is the
    // same reassuring lie the autonomy scoreboard refuses when it returns a null
    // correction rate instead of 0%.
    expect(healthDirection(10, null)).toBeNull();
  });
});

// ── It moves when the queue is worked ───────────────────────────────────────

interface StoredFinding {
  findingId: string;
  producer: DataQualityProducer;
  severity: FindingSeverity;
  status: FindingStatus;
  proposedAction: "none";
  reversibility: "instant";
  partyId: string;
  relatedPartyId: string | null;
  groupKey: string;
}

interface StoredSnapshot {
  capturedOn: string;
  composite: number;
  openTotal: number;
}

/**
 * The findings and the recorded points, in memory.
 *
 * The bridge between the two services under test. Both are constructed against
 * a fake `Db` backed by this one object, so a finding the resolution service
 * closes is a finding the health service can no longer count — which is the
 * whole thing being proven. Nothing here interprets SQL; what it models is the
 * one fact the number depends on, that the composite reads `status = 'open'`.
 */
class Store {
  readonly findings: StoredFinding[] = [];
  readonly snapshots: StoredSnapshot[] = [];
  /** The identifiers the queue last handed out — what a claim then closes. */
  lastSelection: string[] = [];

  add(
    findingId: string,
    producer: DataQualityProducer,
    severity: FindingSeverity,
    groupKey: string,
  ): this {
    this.findings.push({
      findingId,
      producer,
      severity,
      status: "open",
      proposedAction: "none",
      reversibility: "instant",
      partyId: `party-${findingId}`,
      relatedPartyId: null,
      groupKey,
    });
    return this;
  }

  open(): StoredFinding[] {
    return this.findings.filter((row) => row.status === "open");
  }

  /** Exactly the `GROUP BY producer, severity` the health service issues. */
  groupedOpen(): { producer: DataQualityProducer; severity: FindingSeverity; n: number }[] {
    const groups = new Map<string, { producer: DataQualityProducer; severity: FindingSeverity; n: number }>();
    for (const row of this.open()) {
      const key = `${row.producer}:${row.severity}`;
      const entry = groups.get(key) ?? { producer: row.producer, severity: row.severity, n: 0 };
      entry.n += 1;
      groups.set(key, entry);
    }
    return [...groups.values()];
  }

  /** What `claim()` does: close the selected findings that are still open. */
  close(status: FindingStatus): StoredFinding[] {
    const closed = this.findings.filter(
      (row) => this.lastSelection.includes(row.findingId) && row.status === "open",
    );
    for (const row of closed) row.status = status;
    return closed;
  }

  snapshotOn(capturedOn: string): StoredSnapshot | undefined {
    return this.snapshots.find((row) => row.capturedOn === capturedOn);
  }
}

interface ChainCall {
  method: string;
  args: unknown[];
}

/** A Drizzle chain that records what was called on it and resolves through `settle`. */
function chain(settle: (calls: ChainCall[]) => unknown): unknown {
  const calls: ChainCall[] = [];
  const proxy: unknown = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "then")
          return (resolve: (value: unknown) => void) => resolve(settle(calls));
        if (typeof property === "symbol") return undefined;
        return (...args: unknown[]) => {
          calls.push({ method: String(property), args });
          return proxy;
        };
      },
    },
  );
  return proxy;
}

/**
 * A `Db` that routes by table identity.
 *
 * Drizzle hands the table object itself to `.from`, `.insert` and `.update`, so
 * a fake can tell the findings traffic from the snapshot traffic without parsing
 * a single predicate — which is what keeps this a store rather than a
 * half-written database.
 */
function fakeDb(store: Store): Db {
  const arg = (calls: ChainCall[], method: string): unknown =>
    calls.find((call) => call.method === method)?.args[0];

  return {
    select: () =>
      chain((calls) => {
        const table = arg(calls, "from");
        if (table === dataQualityFindings) return store.groupedOpen();
        if (table === dataQualityHealthSnapshots)
          return [...store.snapshots].sort((a, b) => a.capturedOn.localeCompare(b.capturedOn));
        throw new Error("unexpected select");
      }),

    insert: (table: unknown) =>
      chain((calls) => {
        const values = arg(calls, "values") as Record<string, unknown>;

        if (table === dataQualityHealthSnapshots) {
          // The real statement is an upsert on (organization_id, captured_on).
          const capturedOn = String(values["capturedOn"]);
          const point = {
            capturedOn,
            composite: Number(values["composite"]),
            openTotal: Number(values["openTotal"]),
          };
          const existing = store.snapshotOn(capturedOn);
          if (existing) Object.assign(existing, point);
          else store.snapshots.push(point);
          return [];
        }

        // The decision row. Only its identifier is read back.
        return [{ resolutionId: "resolution-1" }];
      }),

    update: (table: unknown) =>
      chain((calls) => {
        if (table !== dataQualityFindings) return [];
        const set = arg(calls, "set") as { status?: FindingStatus };
        if (!set?.status) return [];
        return store.close(set.status);
      }),
  } as unknown as Db;
}

describe("the dataset-health number moves when the queue is worked", () => {
  const ORG = "org-1";

  let store: Store;
  let health: DataQualityHealthService;
  let resolution: DataQualityResolutionService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-03-01T09:00:00.000Z"));

    store = new Store()
      .add("f-1", "duplicate", "high", "duplicate:strong")
      .add("f-2", "duplicate", "high", "duplicate:strong")
      .add("f-3", "contradiction", "medium", "contradiction:tax-number")
      .add("f-4", "staleness", "low", "staleness:180d+")
      .add("f-5", "staleness", "low", "staleness:180d+");

    const db = fakeDb(store);
    health = new DataQualityHealthService(db);

    /**
     * The queue's selection, backed by the same store. A group selection resolves
     * to the open findings carrying that key — which is what the real
     * `selectCandidates` does, and what makes the claim that follows close those
     * exact rows.
     */
    const queue = {
      selectCandidates: jest.fn(async (_org: string, selection: { kind: string; groupKey?: string }) => {
        const rows = store
          .open()
          .filter((row) => selection.kind !== "group" || row.groupKey === selection.groupKey);
        store.lastSelection = rows.map((row) => row.findingId);
        return rows;
      }),
      countOpenInGroup: jest.fn(async (_org: string, groupKey: string) =>
        store.open().filter((row) => row.groupKey === groupKey).length,
      ),
    };

    resolution = new DataQualityResolutionService(
      fakeDb(store),
      queue as unknown as DataQualityQueueService,
      { merge: jest.fn() } as unknown as PartyMergeService,
      health,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("falls by exactly the weight of what a decision closed, and records the fall", async () => {
    const before = await health.capture(ORG);

    // 2 high + 1 medium + 2 low.
    expect(before.composite).toBe(2 * SEVERITY_WEIGHTS.high + SEVERITY_WEIGHTS.medium + 2 * SEVERITY_WEIGHTS.low);
    expect(store.snapshotOn("2026-03-01")?.composite).toBe(before.composite);

    // A day later, somebody works the heaviest group.
    jest.setSystemTime(new Date("2026-03-02T09:00:00.000Z"));

    const decision = await resolution.resolve(ORG, "user-1", {
      selection: { kind: "group", groupKey: "duplicate:strong" },
      action: "apply",
    });

    expect(decision.resolvedCount).toBe(2);

    /**
     * The number is re-read from the queue, not recomputed by the test. Two high
     * findings left it, so the composite must be lower by exactly their weight —
     * a metric that fell by some other amount is measuring something other than
     * what was just closed.
     */
    const after = await health.current(ORG);
    expect(before.composite - after.composite).toBe(2 * SEVERITY_WEIGHTS.high);

    // And the class that was worked is gone from the decomposition entirely.
    expect(after.byClass.map((row) => row.producer)).not.toContain("duplicate");
  });

  it("records the new point itself, so nothing has to remember to", async () => {
    await health.capture(ORG);
    jest.setSystemTime(new Date("2026-03-02T09:00:00.000Z"));

    await resolution.resolve(ORG, "user-1", {
      selection: { kind: "group", groupKey: "duplicate:strong" },
      action: "apply",
    });

    /**
     * The second point exists because `resolve` captured it. This is the link
     * that makes the graph a measurement rather than a drawing: without it the
     * series would only ever gain a point when somebody happened to run a sweep,
     * and a week of triage would show as a flat line.
     */
    expect(store.snapshots.map((row) => row.capturedOn)).toEqual(["2026-03-01", "2026-03-02"]);
    expect(store.snapshotOn("2026-03-02")!.composite).toBeLessThan(
      store.snapshotOn("2026-03-01")!.composite,
    );
  });

  it("reads back as a trend with a direction, not just a smaller number", async () => {
    await health.capture(ORG);
    jest.setSystemTime(new Date("2026-03-02T09:00:00.000Z"));

    await resolution.resolve(ORG, "user-1", {
      selection: { kind: "group", groupKey: "duplicate:strong" },
      action: "apply",
    });

    const trend = await health.trend(ORG, 30);

    expect(trend.series).toHaveLength(2);
    expect(trend.baseline?.capturedOn).toBe("2026-03-01");
    expect(trend.direction).toBe("improving");
    // Negative is progress, because the composite is a penalty.
    expect(trend.delta).toBe(-(2 * SEVERITY_WEIGHTS.high));
  });

  it("has no direction before there is any history to compare against", async () => {
    const trend = await health.trend(ORG, 30);

    expect(trend.series).toHaveLength(0);
    expect(trend.baseline).toBeNull();
    expect(trend.direction).toBeNull();
    expect(trend.delta).toBeNull();
    // The current figure is still real; only the comparison is missing.
    expect(trend.current.composite).toBeGreaterThan(0);
  });

  it("keeps one point per day, so capture can be called from every write path", async () => {
    await health.capture(ORG);
    await health.capture(ORG);
    await health.capture(ORG);

    expect(store.snapshots).toHaveLength(1);
  });

  it("never fails the work that triggered it", async () => {
    const exploding = {
      select: () => {
        throw new Error("connection lost");
      },
    } as unknown as Db;

    // A bulk merge of four hundred records must not fail because a graph point
    // could not be written.
    await expect(new DataQualityHealthService(exploding).captureQuietly(ORG)).resolves.toBeUndefined();
  });
});
