import { NotFoundException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { invHandlingUnits } from "../../../../db/schema";
import { type Db } from "../../../../db/drizzle.module";
import { assertCanHoldStock, type HandlingUnitNode } from "../handling-unit-rules";
import type { HandlingUnitContentRow, HandlingUnitDetail } from "../handling-unit.service";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * The handling-unit tree — reading a node, walking its ancestors and subtree,
 * listing its contents, and the gate that decides whether stock may sit on one.
 * Lifted out of `handling-unit.service.ts` unchanged.
 *
 * All of these took their executor as an argument and touched nothing on the
 * service. What deliberately did NOT move: `scopePredicate` and
 * `detailUnscoped`. `handling-unit-detail-scope.spec.ts` reads the service file
 * as a string and asserts it contains `private scopePredicate(` and
 * `private async detailUnscoped(`, and that `this.detailUnscoped(` appears
 * exactly twice — `detailUnscoped` is the read that skips the warehouse scope,
 * and it is private so no route can be pointed at it by accident. Exporting
 * either would widen that on purpose.
 */
  /* ---------------------------------------------------------------- *
   * internals
   * ---------------------------------------------------------------- */

export async function node(executor: Tx | Db, orgId: string, handlingUnitId: number): Promise<HandlingUnitNode> {
    const [row] = await executor.execute<{
      id: number; parent_hu_id: number | null; location_id: number | null;
      status: string; holds_stock: boolean; child_count: number;
    }>(sql`
      SELECT hu.id, hu.parent_hu_id, hu.location_id, hu.status,
             EXISTS (
               SELECT 1 FROM inv_stock_levels sl
               WHERE sl.org_id = hu.org_id AND sl.handling_unit_id = hu.id AND sl.on_hand <> 0
             ) AS holds_stock,
             (SELECT count(*) FROM inv_handling_units c
              WHERE c.org_id = hu.org_id AND c.parent_hu_id = hu.id)::int AS child_count
      FROM inv_handling_units hu
      WHERE hu.org_id = ${orgId} AND hu.id = ${handlingUnitId}
    `);
    if (!row) throw new NotFoundException("Not found");
    return {
      id: Number(row.id),
      parentHuId: row.parent_hu_id === null ? null : Number(row.parent_hu_id),
      locationId: row.location_id === null ? null : Number(row.location_id),
      status: row.status,
      holdsStock: row.holds_stock === true,
      childCount: Number(row.child_count),
    };
  }

  /** The chain from a unit upwards, nearest first. Bounded, so a bad row cannot loop for ever. */
export async function ancestorsOf(executor: Tx | Db, orgId: string, handlingUnitId: number): Promise<number[]> {
    const rows = await executor.execute<{ id: number }>(sql`
      WITH RECURSIVE chain AS (
        SELECT id, parent_hu_id, 1 AS depth
        FROM inv_handling_units WHERE org_id = ${orgId} AND id = ${handlingUnitId}
        UNION ALL
        SELECT hu.id, hu.parent_hu_id, chain.depth + 1
        FROM inv_handling_units hu
        JOIN chain ON hu.id = chain.parent_hu_id
        WHERE hu.org_id = ${orgId} AND chain.depth < 32
      )
      SELECT id FROM chain
    `);
    return rows.map((r) => Number(r.id));
  }

  /** A unit and every unit nested inside it, to any depth. */
export async function subtreeIds(executor: Tx | Db, orgId: string, handlingUnitId: number): Promise<number[]> {
    const rows = await executor.execute<{ id: number }>(sql`
      WITH RECURSIVE tree AS (
        SELECT id, 1 AS depth FROM inv_handling_units
        WHERE org_id = ${orgId} AND id = ${handlingUnitId}
        UNION ALL
        SELECT hu.id, tree.depth + 1
        FROM inv_handling_units hu
        JOIN tree ON hu.parent_hu_id = tree.id
        WHERE hu.org_id = ${orgId} AND tree.depth < 32
      )
      SELECT id FROM tree
    `);
    return rows.map((r) => Number(r.id));
  }

export async function contentsOf(
    executor: Tx | Db,
    orgId: string,
    handlingUnitIds: readonly number[],
  ): Promise<Array<HandlingUnitContentRow & { currentLocationId: number }>> {
    if (handlingUnitIds.length === 0) return [];
    const rows = await executor.execute<{
      product_variant_id: number; lot_id: number | null; serial_id: number | null;
      handling_unit_id: number; location_id: number; on_hand: string;
      ownership: "OWNED" | "VENDOR" | "CUSTOMER";
    }>(sql`
      SELECT product_variant_id, lot_id, serial_id, handling_unit_id, location_id, on_hand, ownership
      FROM inv_stock_levels
      WHERE org_id = ${orgId}
        AND handling_unit_id IN (${sql.join(handlingUnitIds.map((id) => sql`${id}`), sql`, `)})
        AND on_hand <> 0
      ORDER BY id
    `);
    return rows.map((r) => ({
      productVariantId: Number(r.product_variant_id),
      lotId: r.lot_id === null ? null : Number(r.lot_id),
      serialId: r.serial_id === null ? null : Number(r.serial_id),
      handlingUnitId: Number(r.handling_unit_id),
      ownership: r.ownership,
      currentLocationId: Number(r.location_id),
      onHand: String(r.on_hand),
    }));
  }

export async function detailIn(tx: Tx, orgId: string, handlingUnitId: number): Promise<HandlingUnitDetail> {
    // Renamed from `node` when this moved out of the class: `this.node(...)`
    // became `node(...)`, so the old local shadowed the function it calls.
    const unit = await node(tx, orgId, handlingUnitId);
    const [row] = await tx
      .select({
        id: invHandlingUnits.id,
        huCode: invHandlingUnits.huCode,
        kind: invHandlingUnits.kind,
        status: invHandlingUnits.status,
        locationId: invHandlingUnits.locationId,
        parentHuId: invHandlingUnits.parentHuId,
      })
      .from(invHandlingUnits)
      .where(and(eq(invHandlingUnits.orgId, orgId), eq(invHandlingUnits.id, handlingUnitId)));
    if (!row) throw new NotFoundException("Not found");

    const children = await tx
      .select({ id: invHandlingUnits.id })
      .from(invHandlingUnits)
      .where(and(eq(invHandlingUnits.orgId, orgId), eq(invHandlingUnits.parentHuId, handlingUnitId)));

    const rolledUp = await contentsOf(tx, orgId, await subtreeIds(tx, orgId, handlingUnitId));

    return {
      ...row,
      childIds: children.map((c) => c.id),
      contents: unit.holdsStock ? rolledUp.filter((r) => r.handlingUnitId === handlingUnitId) : [],
      rolledUpContents: rolledUp,
    };
  }

  /**
   * The gate every path that puts stock onto a handling unit passes through -
   * receiving, putaway, an adjustment that names one.
   *
   * It is a service method rather than a private helper because receiving is in
   * another module and must ask rather than carry a copy of the rule.
   */
export async function assertCanHoldStockInTx(tx: Tx, orgId: string, handlingUnitId: number): Promise<void> {
    assertCanHoldStock(await node(tx, orgId, handlingUnitId));
  }
