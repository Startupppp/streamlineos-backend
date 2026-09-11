/**
 * `GET /inventory/stock`, as it reaches the wire, and the re-nesting that gets
 * it there.
 *
 * These four declarations are one thing: a shape, the join row it is built
 * from, the function that converts between them, and the discriminator that
 * keeps a cache from serving an older version of it. The service that queries
 * the rows is not where that contract lives — the frontend hook writes the same
 * shape out field for field (`RawStockLevel` in
 * `hooks/api/inventory/stock-levels.ts`) and `stock-levels-response-shape.spec.ts`
 * pins the two together, so this is the backend half of a cross-repo agreement
 * rather than an implementation detail of one query.
 */

/**
 * The response shape, as a cache-key discriminator.
 *
 * `listStockLevels` is cached, and the row shape changed: the response used to
 * carry the driver's own snake_case column names and no joins at all, so
 * `on_hand` arrived where the client reads `onHand` and every product and
 * location name rendered as a dash. Entries of that old shape are still sitting
 * in Redis under the current namespace version at deploy time, and the version
 * is per-org -- there is no boot-time hook that could bump every tenant's.
 *
 * So the shape rides in the key instead of relying on eviction. A new deploy
 * simply reads at a key no old entry occupies, which costs one cold fill per
 * key and cannot serve a single stale row of the previous shape. Bump it
 * whenever the fields below change again.
 */
export const RESPONSE_SHAPE = "s2";

/**
 * One stock-level row as it reaches the wire.
 *
 * Written out rather than inferred because the frontend hook writes it out too
 * (`RawStockLevel` in `hooks/api/inventory/stock-levels.ts`) and the two halves
 * are a contract: this is the shape that hook parses, field for field, and the
 * nesting mirrors `listTransactions` because that is how this module already
 * hands a client an identity for a variant and a bin.
 *
 * Every quantity is a STRING. These are Postgres `numeric` columns, the driver
 * returns them as strings, and the hook's type says string and calls `Number()`
 * on them. Declaring a number here and shipping a string is precisely how the
 * table came to read `NaN`.
 */
export interface StockLevelItem {
  id: number;
  onHand: string;
  committed: string;
  onOrder: string;
  available: string;
  blockedQty: string;
  qualityHoldQty: string;
  averageCost: string | null;
  productVariant: {
    id: number;
    name: string | null;
    sku: string | null;
    product: { id: number; name: string; sku: string; reorderPoint: string | null } | null;
  } | null;
  location: {
    id: number;
    name: string;
    code: string;
    warehouse: { id: number; name: string } | null;
  } | null;
}

/**
 * The row as the join hands it over.
 *
 * Drizzle's `select()` groups columns one level deep and no further -- a third
 * level is not a nested selection to it, it is a value, and it fails to compile.
 * So the product and the warehouse ride flat inside their parent's group and are
 * re-nested by `toStockLevelItem` below. That is also why nothing here is
 * nullable-by-group: a group mixing two tables is never nullified wholesale by
 * the driver mapper, so each field arrives null on its own and the parent object
 * is decided explicitly.
 */
export interface StockLevelJoinRow {
  id: number;
  onHand: string;
  committed: string;
  onOrder: string;
  available: string;
  blockedQty: string;
  qualityHoldQty: string;
  averageCost: string | null;
  productVariant: {
    id: number | null;
    name: string | null;
    sku: string | null;
    productId: number | null;
    productName: string | null;
    productSku: string | null;
    reorderPoint: string | null;
  };
  location: {
    id: number | null;
    name: string | null;
    code: string | null;
    warehouseId: number | null;
    warehouseName: string | null;
  };
}

/**
 * Re-nests a joined row into the shape the client parses.
 *
 * The null checks are per-field rather than a single `id === null` probe on
 * purpose: `name` and `code` are `NOT NULL` columns, so testing them is what
 * narrows them from `string | null` to `string` without an assertion, and an
 * assertion is the thing that would let a genuinely absent join through as a
 * half-built object.
 */
export function toStockLevelItem(row: StockLevelJoinRow): StockLevelItem {
  const variant = row.productVariant;
  const location = row.location;

  const product =
    variant.productId !== null && variant.productName !== null && variant.productSku !== null
      ? { id: variant.productId, name: variant.productName, sku: variant.productSku, reorderPoint: variant.reorderPoint }
      : null;

  const warehouse =
    location.warehouseId !== null && location.warehouseName !== null
      ? { id: location.warehouseId, name: location.warehouseName }
      : null;

  return {
    id: row.id,
    onHand: row.onHand,
    committed: row.committed,
    onOrder: row.onOrder,
    available: row.available,
    blockedQty: row.blockedQty,
    qualityHoldQty: row.qualityHoldQty,
    averageCost: row.averageCost,
    productVariant:
      variant.id === null
        ? null
        : { id: variant.id, name: variant.name, sku: variant.sku, product },
    location:
      location.id === null || location.name === null || location.code === null
        ? null
        : { id: location.id, name: location.name, code: location.code, warehouse },
  };
}
