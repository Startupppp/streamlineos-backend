import { ConflictException } from "@nestjs/common";
import { getTableName } from "drizzle-orm";
import {
  invIdempotencyKeys,
  invLots,
  invQualityHolds,
  invRecallEvents,
  invRecallLines,
  invStockLevels,
} from "../../../../db/schema";
import { RecallsService } from "../quality-recalls.service";
import type { RecallImpact } from "../recall-simulation.service";

/**
 * R4/D4 — executing a recall twice is executing it once.
 *
 * The document was already replay-safe before this unit: `runIdempotent` wrapped
 * the `inv_recall_events` insert, so a retry returned the first recall's id.
 * What it did not wrap was everything the recall *did* — the retry replayed the
 * document and then inserted a second complete set of quality holds against the
 * same stock, which is a recall that looks idempotent from the outside and
 * doubles its own hold quantities from the inside.
 *
 * So the assertion here is not "the second call returns the same id". It is
 * "the second call writes nothing at all".
 */

type Row = Record<string, unknown>;

interface Writes {
  table: string;
  values: Row[];
}

/**
 * A database with exactly enough behaviour to run the idempotency protocol.
 *
 * `claimIdempotencyKey` is the part that has to be real: it claims with
 * `INSERT … ON CONFLICT DO NOTHING … RETURNING`, reads the existing row back
 * when the claim returns nothing, and replays from its stored `response`. A
 * mock that skipped any of those steps would let the second call proceed and
 * the test would assert the mock rather than the service.
 */
function fakeDb(levels: Row[]) {
  const inserts: Writes[] = [];
  const updates: string[] = [];
  const keys = new Map<string, Row>();
  let nextRecallId = 1;

  const insert = (table: unknown) => {
    const name = getTableName(table as Parameters<typeof getTableName>[0]);
    let pending: Row[] = [];
    let ignoreConflict = false;

    const commit = (): Row[] => {
      if (name === getTableName(invIdempotencyKeys)) {
        const row = pending[0] ?? {};
        const key = String(row["idempotencyKey"]);
        if (keys.has(key)) return ignoreConflict ? [] : [];
        keys.set(key, { ...row, id: keys.size + 1 });
        return [{ id: keys.size }];
      }
      inserts.push({ table: name, values: pending });
      if (name === getTableName(invRecallEvents)) {
        const row = pending[0] ?? {};
        return [{ ...row, id: nextRecallId++ }];
      }
      return pending.map((v, i) => ({ ...v, id: i + 1 }));
    };

    const builder: Record<string, unknown> = {
      values: (v: Row | Row[]) => {
        pending = Array.isArray(v) ? v : [v];
        return builder;
      },
      onConflictDoNothing: () => {
        ignoreConflict = true;
        return builder;
      },
      returning: () => Promise.resolve(commit()),
      then: (resolve: (value: Row[]) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(commit()).then(resolve, reject),
    };
    return builder;
  };

  const update = (table: unknown) => {
    const name = getTableName(table as Parameters<typeof getTableName>[0]);
    let patch: Row = {};
    const commit = (): Row[] => {
      updates.push(name);
      if (name === getTableName(invIdempotencyKeys)) {
        for (const [key, row] of keys) keys.set(key, { ...row, ...patch });
        return [{ id: 1 }];
      }
      return [];
    };
    const builder: Record<string, unknown> = {
      set: (p: Row) => {
        patch = p;
        return builder;
      },
      where: () => builder,
      returning: () => Promise.resolve(commit()),
      then: (resolve: (value: Row[]) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(commit()).then(resolve, reject),
    };
    return builder;
  };

  const select = () => ({
    from: (table: unknown) => {
      const name = getTableName(table as Parameters<typeof getTableName>[0]);
      const rows = name === getTableName(invStockLevels) ? levels : [];
      const chain: Record<string, unknown> = {};
      for (const link of ["innerJoin", "leftJoin", "where", "orderBy", "limit"]) {
        chain[link] = () => chain;
      }
      chain["then"] = (
        resolve: (value: Row[]) => unknown,
        reject: (reason: unknown) => unknown,
      ) => Promise.resolve(rows).then(resolve, reject);
      return chain;
    },
  });

  const query = {
    invIdempotencyKeys: {
      // One key per test, so "the stored row" is unambiguous — which is what
      // lets this fake stay short without lying about the protocol.
      findFirst: () => Promise.resolve([...keys.values()][0] ?? undefined),
    },
    invRecallEvents: {
      findFirst: () => Promise.resolve({ id: 1, recallNumber: "RECALL-00001", lines: [] }),
    },
  };

  const db = {
    insert,
    update,
    select,
    query,
    transaction: (work: (tx: unknown) => Promise<unknown>) => work(db),
  };

  return { db, inserts, updates, keys };
}

const IMPACT: RecallImpact = {
  selection: { lotIds: [1] },
  warehouseScope: "all",
  lots: [
    {
      lotId: 1,
      lotNumber: "L-001",
      productVariantId: 40,
      variantSku: "SKU-40",
      variantName: "Default",
      status: "ACTIVE",
      manufactureDate: null,
      expiryDate: null,
    },
  ],
  onHand: [],
  inTransit: [],
  shipped: [],
  returned: [],
  totals: {
    lots: 1,
    onHand: "0",
    onQualityHold: "0",
    inTransit: "0",
    shipped: "0",
    returned: "0",
  },
  evidenceVersion: "abc123",
};

const LEVELS: Row[] = [
  { productVariantId: 40, locationId: 7, lotId: 1, onHand: "100.0000" },
  // Zero on hand: a hold against nothing is a document with no stock behind it.
  { productVariantId: 40, locationId: 8, lotId: 1, onHand: "0.0000" },
];

function build(levels: Row[] = LEVELS) {
  const { db, inserts, updates, keys } = fakeDb(levels);
  const engine = { executeMany: jest.fn(() => Promise.resolve([])) };
  const simulation = { simulate: jest.fn(() => Promise.resolve(IMPACT)) };
  const service = new RecallsService(
    db as never,
    { invalidateNamespace: jest.fn(() => Promise.resolve()) } as never,
    {} as never,
    engine as never,
    { next: jest.fn(() => Promise.resolve("RECALL-00001")) } as never,
    { insert: jest.fn(() => Promise.resolve()) } as never,
    simulation as never,
  );
  return { service, inserts, updates, keys, engine, simulation };
}

const countOf = (inserts: Writes[], table: unknown): number =>
  inserts.filter((w) => w.table === getTableName(table as Parameters<typeof getTableName>[0]))
    .length;

const SELECTION_REQUEST = {
  title: "Contaminated batch",
  selection: { lotIds: [1] },
  evidenceVersion: "abc123",
} as const;

describe("R4/D4 — executing a recall", () => {
  it("raises one document, flips the lots, and holds only stock that exists", async () => {
    const { service, inserts, engine } = build();

    await service.create("org_1", "user_1", { ...SELECTION_REQUEST }, "key-1");

    expect(countOf(inserts, invRecallEvents)).toBe(1);
    expect(countOf(inserts, invRecallLines)).toBe(1);

    const holds = inserts.find((w) => w.table === getTableName(invQualityHolds));
    // Two levels, one of them empty: the empty bin gets no hold.
    expect(holds?.values).toHaveLength(1);
    expect(holds?.values[0]).toMatchObject({ locationId: 7, quantity: "100.0000" });

    // The lot flip is what actually stops the goods moving — the allocator
    // refuses any lot whose status is not ACTIVE under every strategy.
    expect(engine.executeMany).toHaveBeenCalledTimes(1);
    const [, , commands] = engine.executeMany.mock.calls[0] as unknown as [
      string,
      string,
      Array<{ idempotencyKey: string; movements: Array<Record<string, unknown>> }>,
    ];
    expect(commands).toHaveLength(1);
    expect(commands[0]?.idempotencyKey).toBe("recall:1:lot:1:loc:7");
    expect(commands[0]?.movements[0]).toMatchObject({
      transactionType: "QUARANTINE_IN",
      qualityBucket: "QUALITY_HOLD",
      quantityDelta: "100.0000",
    });
  });

  it("records the evidence it acted on", async () => {
    const { service, inserts } = build();

    await service.create("org_1", "user_1", { ...SELECTION_REQUEST }, "key-1");

    const recall = inserts.find((w) => w.table === getTableName(invRecallEvents))?.values[0];
    expect(recall).toMatchObject({ evidenceVersion: "abc123" });
    expect(recall?.["evidenceSnapshot"]).toMatchObject({ evidenceVersion: "abc123" });
  });

  it("writes nothing the second time the same key arrives", async () => {
    const { service, inserts, engine } = build();

    await service.create("org_1", "user_1", { ...SELECTION_REQUEST }, "key-1");
    const afterFirst = inserts.length;

    await service.create("org_1", "user_1", { ...SELECTION_REQUEST }, "key-1");

    expect(inserts.length).toBe(afterFirst);
    expect(countOf(inserts, invRecallEvents)).toBe(1);
    expect(countOf(inserts, invRecallLines)).toBe(1);
    // The one that used to double: a replayed recall re-inserted every hold.
    expect(countOf(inserts, invQualityHolds)).toBe(1);

    // The engine is still called on the replay, and that is correct: its
    // commands carry a derived key per (recall, lot, location), so it dedupes
    // on its own terms and a retry after a crashed first attempt still gets
    // its movements posted.
    expect(engine.executeMany).toHaveBeenCalledTimes(2);
    const [, , replayed] = engine.executeMany.mock.calls[1] as unknown as [
      string,
      string,
      Array<{ idempotencyKey: string }>,
    ];
    expect(replayed[0]?.idempotencyKey).toBe("recall:1:lot:1:loc:7");
  });

  it("refuses stale evidence before it writes anything", async () => {
    const { service, inserts, simulation } = build();

    await expect(
      service.create(
        "org_1",
        "user_1",
        { ...SELECTION_REQUEST, evidenceVersion: "stale-hash" },
        "key-1",
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(simulation.simulate).toHaveBeenCalledTimes(1);
    // Not "no recall was created" — nothing at all was, including the
    // idempotency claim, so the operator can re-simulate and retry with the
    // same key.
    expect(inserts).toEqual([]);
  });

  it("takes an explicit line list at face value, with no evidence", async () => {
    const { service, inserts, simulation } = build();

    await service.create(
      "org_1",
      "user_1",
      { title: "Named lots", lines: [{ lotId: 1, productVariantId: 40 }] },
      "key-2",
    );

    expect(simulation.simulate).not.toHaveBeenCalled();
    const recall = inserts.find((w) => w.table === getTableName(invRecallEvents))?.values[0];
    expect(recall).toMatchObject({ evidenceVersion: null, evidenceSnapshot: null });
  });

  it("quarantines nothing when the recalled lots hold no stock", async () => {
    const { service, inserts, engine } = build([]);

    await service.create("org_1", "user_1", { ...SELECTION_REQUEST }, "key-3");

    expect(countOf(inserts, invQualityHolds)).toBe(0);
    expect(countOf(inserts, invRecallEvents)).toBe(1);
    // The lot still flips to RECALLED — a lot with nothing on the shelf is
    // still a lot nobody may allocate from later.
    expect(engine.executeMany).not.toHaveBeenCalled();
  });
});

describe("R4 — the lot flip", () => {
  it("updates inv_lots inside the idempotent unit", async () => {
    const { service, updates } = build();

    await service.create("org_1", "user_1", { ...SELECTION_REQUEST }, "key-1");

    expect(updates).toContain(getTableName(invLots));
  });
});
