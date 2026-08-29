import { and, eq, isNull, or } from "drizzle-orm";
import { invCustomerShelfLifeRules, invSalesOrders } from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";

/**
 * D2 — where the minimum-shelf-life threshold lives, and nowhere else.
 *
 * One table, `inv_customer_shelf_life_rules`, with two rungs:
 *
 *   * a row naming a `client_id` — that customer's contracted floor;
 *   * the single row with `client_id IS NULL` — the house floor, applied to
 *     every customer without one of their own.
 *
 * No row at all means no floor. That is deliberate rather than a gap: a
 * shelf-life guarantee is a term of a supply agreement, and there is no such
 * thing as a default supply agreement. An organisation that wants one writes
 * the house row.
 *
 * Not on `inv_settings`, because one number per tenant is the exact thing this
 * exists to stop being — that is `nearExpiryWindowDays`, which answers a
 * different question (see `lot-eligibility.ts`). Not on `clients` either: that
 * table belongs to CRM, and hanging a warehouse allocation rule off it would put
 * an inventory concern in every CRM read (backend §1).
 */

/** `days === 0` means no floor; `source` is what a UI shows and an audit row records. */
export interface ShelfLifeFloor {
  readonly days: number;
  readonly source: "CUSTOMER" | "HOUSE" | "NONE";
  readonly clientId: number | null;
}

export const NO_SHELF_LIFE_FLOOR: ShelfLifeFloor = { days: 0, source: "NONE", clientId: null };

/**
 * The floor in force for one customer — the customer's own rule, else the house
 * rule, else none.
 *
 * Both candidate rows come back in one query rather than two round trips, and
 * the more specific one wins in memory. `clientId === null` (an allocation with
 * no customer behind it — a transfer, an internal issue) can only ever reach the
 * house rung, which is correct: a contract with nobody is not a contract.
 */
export async function resolveShelfLifeFloor(
  db: Db,
  orgId: string,
  clientId: number | null,
): Promise<ShelfLifeFloor> {
  const rows = await db
    .select({
      clientId: invCustomerShelfLifeRules.clientId,
      minShelfLifeDays: invCustomerShelfLifeRules.minShelfLifeDays,
    })
    .from(invCustomerShelfLifeRules)
    .where(
      and(
        eq(invCustomerShelfLifeRules.orgId, orgId),
        clientId === null
          ? isNull(invCustomerShelfLifeRules.clientId)
          : or(
              isNull(invCustomerShelfLifeRules.clientId),
              eq(invCustomerShelfLifeRules.clientId, clientId),
            ),
      ),
    );

  const own = rows.find((row) => row.clientId !== null);
  if (own) return { days: own.minShelfLifeDays, source: "CUSTOMER", clientId: own.clientId };

  const house = rows.find((row) => row.clientId === null);
  if (house) return { days: house.minShelfLifeDays, source: "HOUSE", clientId: null };

  return NO_SHELF_LIFE_FLOOR;
}

/**
 * The customer a reservation is ultimately for, or null.
 *
 * A reservation names a document, not a person. `inv_sales_order` is the only
 * source type that has a customer behind it today; everything else — a transfer,
 * a work order, a hand-raised hold — genuinely has none, and returning null for
 * those is the right answer rather than a missing feature. A source id that does
 * not parse, or names an order in another tenant, resolves to null and the
 * allocation is simply unconstrained; it never leaks whether that order exists.
 */
export async function clientBehindSource(
  db: Db,
  orgId: string,
  sourceType: string,
  sourceId: string,
): Promise<number | null> {
  if (sourceType !== "inv_sales_order") return null;
  const soId = Number(sourceId);
  if (!Number.isInteger(soId) || soId <= 0) return null;

  const so = await db.query.invSalesOrders.findFirst({
    where: and(eq(invSalesOrders.orgId, orgId), eq(invSalesOrders.id, soId)),
    columns: { clientId: true },
  });
  return so?.clientId ?? null;
}
