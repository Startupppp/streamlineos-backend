/**
 * INV-105 — the lock order is the whole point of this module.
 *
 * The single-command path used to lock rows as its movement loop reached them,
 * so two concurrent commands over the same grains in opposite order could take
 * them in opposite order and deadlock. Postgres would abort one of them, and
 * the caller would see a 500 rather than a retryable conflict.
 */
import { lockLevels, levelKey, type LevelGrain } from "../stock-level-locks";

interface Recorder {
  inserts: string[];
  lockSql: string;
  tx: Parameters<typeof lockLevels>[0];
}

function recordingTx(rows: Record<string, unknown>[] = []): Recorder {
  const rec: Recorder = { inserts: [], lockSql: "", tx: undefined as never };
  const insert = jest.fn().mockReturnValue({
    values: (v: Record<string, unknown>) => {
      rec.inserts.push(levelKey(v as unknown as LevelGrain));
      return { onConflictDoNothing: () => Promise.resolve(undefined) };
    },
  });
  const execute = jest.fn().mockImplementation((query: { queryChunks?: unknown[] }) => {
    rec.lockSql = JSON.stringify(query.queryChunks ?? query);
    return Promise.resolve(rows);
  });
  rec.tx = { insert, execute } as never;
  return rec;
}

const GRAIN_A: LevelGrain = { productVariantId: 7, locationId: 3, lotId: null, serialId: null, handlingUnitId: null, ownership: "OWNED" };
const GRAIN_B: LevelGrain = { productVariantId: 2, locationId: 9, lotId: 4, serialId: null, handlingUnitId: null, ownership: "OWNED" };
const GRAIN_C: LevelGrain = { productVariantId: 2, locationId: 9, lotId: 1, serialId: null, handlingUnitId: null, ownership: "OWNED" };
/** NEO-4. Same bin, same lot, different pallet: a distinct grain, and it sorts last. */
const GRAIN_D: LevelGrain = { productVariantId: 2, locationId: 9, lotId: 4, serialId: null, handlingUnitId: 11, ownership: "OWNED" };

describe("lockLevels", () => {
  it("creates missing rows in the same order however the caller sends them", async () => {
    const forward = recordingTx();
    await lockLevels(forward.tx, "org1", [GRAIN_A, GRAIN_B, GRAIN_C]);
    const reverse = recordingTx();
    await lockLevels(reverse.tx, "org1", [GRAIN_C, GRAIN_B, GRAIN_A]);

    expect(forward.inserts).toEqual(reverse.inserts);
    expect(forward.inserts).toEqual([levelKey(GRAIN_C), levelKey(GRAIN_B), levelKey(GRAIN_A)]);

    // NEO-4. Same bin, same lot, different pallet: a distinct grain, and it sorts
    // after the loose one rather than colliding with it. Asserted here because a
    // key that quietly lost a dimension addresses a different row, and the
    // ordering is what stops two concurrent commands deadlocking on the insert.
    const withUnit = recordingTx();
    await lockLevels(withUnit.tx, "org1", [GRAIN_D, GRAIN_B]);
    expect(withUnit.inserts).toEqual([levelKey(GRAIN_B), levelKey(GRAIN_D)]);
  });

  it("locks with ORDER BY id FOR UPDATE", async () => {
    const rec = recordingTx();
    await lockLevels(rec.tx, "org1", [GRAIN_A]);
    expect(rec.lockSql).toContain("ORDER BY id");
    expect(rec.lockSql).toContain("FOR UPDATE");
  });

  it("collapses duplicate grains so one row is never locked twice", async () => {
    const rec = recordingTx();
    await lockLevels(rec.tx, "org1", [GRAIN_A, { ...GRAIN_A }, GRAIN_A]);
    expect(rec.inserts).toEqual([levelKey(GRAIN_A)]);
  });

  it("does nothing at all when there are no movements", async () => {
    const rec = recordingTx();
    const result = await lockLevels(rec.tx, "org1", []);
    expect(result.size).toBe(0);
    expect(rec.inserts).toEqual([]);
    expect(rec.lockSql).toBe("");
  });

  it("keys the returned rows by the same natural key the caller looks up with", async () => {
    const rec = recordingTx([
      {
        id: 11, product_variant_id: 7, location_id: 3, lot_id: null, serial_id: null,
        // NEO-4 and NEO-11 both widened the natural key; a fixture row missing
        // either lands under a different key than the caller looks up with.
        handling_unit_id: null, ownership: "OWNED",
        on_hand: "5.0000", committed: "0.0000", blocked_qty: "0.0000",
        quality_hold_qty: "0.0000", average_cost: "2.5000",
      },
    ]);
    const locked = await lockLevels(rec.tx, "org1", [GRAIN_A]);
    expect(locked.get(levelKey(GRAIN_A))).toMatchObject({ id: 11, onHand: "5.0000", averageCost: "2.5000" });
  });

  it("defaults null bucket quantities to zero rather than leaking null into arithmetic", async () => {
    const rec = recordingTx([
      {
        id: 12, product_variant_id: 2, location_id: 9, lot_id: 4, serial_id: null,
        handling_unit_id: null, ownership: "OWNED",
        on_hand: "1.0000", committed: "0.0000", blocked_qty: null,
        quality_hold_qty: null, average_cost: null,
      },
    ]);
    const locked = await lockLevels(rec.tx, "org1", [GRAIN_B]);
    expect(locked.get(levelKey(GRAIN_B))).toMatchObject({ blockedQty: "0", qualityHoldQty: "0" });
  });
});
