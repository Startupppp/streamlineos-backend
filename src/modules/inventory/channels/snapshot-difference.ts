import { subDec, cmpDec } from "../stock-engine/decimal";
import type { ChannelSnapshotResult } from "./channel-adapter";

/**
 * E6 — what a snapshot means, as a pure function.
 *
 * Separated from the service that writes the rows because the rule this encodes
 * is the one thing in the unit that must never be got wrong, and it is not
 * checkable while it is spread through a loop that is also doing SQL:
 *
 *   **A SKU the channel did not mention has told us nothing, and "nothing" is
 *   not "zero".**
 *
 * The failure that rule exists to prevent is specific and real. A marketplace
 * that answers HTTP 200 with `{"errors": [...]}` and no items is, at the
 * transport layer, indistinguishable from one that genuinely has nothing in
 * stock. Fold the two together and every SKU we publish acquires a difference of
 * `0 − whatever we hold`, which under `ALLOW_ADJUSTMENT` is a one-request path
 * to writing a warehouse down to nothing. Only items actually present in
 * `snapshot.items` produce a row here; the published SKU list is used to *ask*
 * the channel, never to synthesise an answer it did not give.
 *
 * Agreement is not a finding either. A matched SKU whose figures agree produces
 * nothing, so the difference list stays a list of disagreements rather than a
 * copy of the catalogue with most of it marked fine.
 */
export interface SnapshotDifference {
  readonly externalSku: string;
  /** Null when the channel's SKU matches no variant of ours — a real finding. */
  readonly productVariantId: number | null;
  readonly channelQty: string;
  readonly internalQty: string;
  /** `channelQty − internalQty`. Positive means the channel believes it has more. */
  readonly difference: string;
}

export function planSnapshotDifferences(input: {
  readonly snapshot: Extract<ChannelSnapshotResult, { ok: true }>;
  readonly skuToVariant: ReadonlyMap<string, number>;
  readonly internalAvailability: ReadonlyMap<number, string>;
}): SnapshotDifference[] {
  const out: SnapshotDifference[] = [];

  for (const item of input.snapshot.items) {
    const productVariantId = input.skuToVariant.get(item.sku) ?? null;

    // An unmapped SKU has no internal position by definition, and reporting it
    // against 0 is the point: "the channel is selling something we do not stock"
    // is the single most useful thing this table says.
    const internalQty =
      productVariantId === null
        ? "0.0000"
        : input.internalAvailability.get(productVariantId) ?? "0.0000";

    const difference = subDec(item.quantity, internalQty);
    if (productVariantId !== null && cmpDec(difference, "0") === 0) continue;

    out.push({
      externalSku: item.sku,
      productVariantId,
      channelQty: item.quantity,
      internalQty,
      difference,
    });
  }

  return out;
}
