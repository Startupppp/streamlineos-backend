import type { invRecallEvents, invRecallLines } from "../../../../db/schema";

/**
 * The detail shape `loadRecallDetail` returns.
 *
 * Spelled out rather than inferred because that read stays PRIVATE on the
 * service — it is the one that can run without `recallInScope` — and the create
 * flow receives it as a bound callback. A callback needs a return type.
 */
export type RecallDetail = typeof invRecallEvents.$inferSelect & {
  readonly lines: (typeof invRecallLines.$inferSelect)[];
  readonly affectedShipments: Array<{ shipmentId: number; shipmentNumber: string }>;
};

/**
 * What the idempotent unit of `createRecall` produces, and how it comes back.
 *
 * Kept beside the type rather than in the flow: the reviver exists precisely
 * because the stored value has been through `jsonb`, and reading the shape and
 * the revive together is the only way to see that no field is being asserted
 * rather than checked.
 */

/**
 * What the quarantine leg did to one recall line, stored on the line.
 *
 * `OPEN` is not in this union on purpose. It is the column default and means
 * "no outcome was recorded" — every line of every recall raised before INV-33.
 * The UI renders it as pending rather than as success, because a recall that
 * cannot say what it held is exactly the one nobody should trust.
 */
export type RecallLineOutcome = "QUARANTINED" | "NOTHING_TO_QUARANTINE" | "NOT_QUARANTINABLE";

/** What the idempotent unit of `create` produces, and replays. */
export interface ExecutedRecall {
  recall: { id: number; recallNumber: string };
  /** The exact stock grains the engine quarantined, at their on-hand. */
  quarantine: Array<{
    productVariantId: number;
    locationId: number;
    lotId: number;
    handlingUnitId: number | null;
    ownership: "OWNED" | "VENDOR" | "CUSTOMER";
    onHand: string;
  }>;
}

/**
 * A replayed recall, rebuilt from the stored JSON.
 *
 * The stored response is JSON that has been through the database, so every
 * number arrived as whatever `jsonb` gave back and a blind cast would be a lie
 * the type system cannot catch — hence a revive rather than an assertion.
 * Quantities stay strings: they are 18,4 numerics, and `Number()` on one is the
 * float arithmetic the ledger rules forbid.
 */
export function reviveRecall(stored: unknown): ExecutedRecall {
  const row = typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {};
  const recall = typeof row.recall === "object" && row.recall !== null
    ? (row.recall as Record<string, unknown>)
    : {};
  const quarantine = Array.isArray(row.quarantine) ? row.quarantine : [];
  return {
    recall: { id: Number(recall.id ?? 0), recallNumber: String(recall.recallNumber ?? "") },
    quarantine: quarantine.flatMap((q) => {
      const g = typeof q === "object" && q !== null ? (q as Record<string, unknown>) : {};
      if (g.lotId == null || g.locationId == null) return [];
      return [{
        productVariantId: Number(g.productVariantId),
        locationId: Number(g.locationId),
        lotId: Number(g.lotId),
        handlingUnitId: g.handlingUnitId == null ? null : Number(g.handlingUnitId),
        ownership:
          g.ownership === "VENDOR" || g.ownership === "CUSTOMER"
            ? g.ownership
            : "OWNED",
        onHand: String(g.onHand ?? "0"),
      }];
    }),
  };
}

/**
 * D4 — execute a recall.
 *
 * Two shapes of request reach here. An explicit `lines` list is the caller
 * naming lots and serials outright. A `selection` is the caller naming the
 * *question* — "everything this vendor sent us in March" — and presenting
 * the `evidenceVersion` a simulate returned for it; the simulation is re-run
 * here and a moved picture is a 409, never a silent execution against
 * numbers an operator read ten minutes ago.
 */
