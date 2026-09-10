import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { invHandlingUnits, invLocations } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { StockEngineService } from "../stock-engine/stock-engine.service";
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { runIdempotent } from "../stock-engine/idempotency";
import {
  assertCanHoldStock,
  assertCanTakeChildren,
  assertNoCycle,
  type HandlingUnitNode,
} from "./handling-unit-rules";
import type {
  CreateHandlingUnitInput,
  MoveHandlingUnitInput,
  NestHandlingUnitInput,
} from "./dto/handling-units.schemas";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface HandlingUnitContentRow {
  productVariantId: number;
  lotId: number | null;
  serialId: number | null;
  handlingUnitId: number;
  /**
   * INV-18 - whose stock this is. Part of `inv_stock_levels`' natural key, and
   * the component this read used to drop: a pallet holding a supplier's cartons
   * looked identical to one holding our own, and `move` then posted both as
   * `OWNED`.
   */
  ownership: "OWNED" | "VENDOR" | "CUSTOMER";
  onHand: string;
}

export interface HandlingUnitDetail {
  id: number;
  huCode: string;
  kind: string;
  status: string;
  locationId: number | null;
  parentHuId: number | null;
  childIds: number[];
  /** Held on this unit only. A parent's own contents are always empty. */
  contents: HandlingUnitContentRow[];
  /** This unit's contents plus every descendant's, which is what a label means. */
  rolledUpContents: HandlingUnitContentRow[];
}

/**
 * NEO-4 - the pallet, and what may be done to it.
 *
 * The engine still owns every quantity. Nothing here writes `on_hand` directly:
 * moving a handling unit posts an ordinary pair of movements through
 * `StockEngineService`, one out of the old bin and one into the new, exactly as
 * a transfer does. What this service adds is that the pair is generated from the
 * unit rather than typed by a person, which is the whole point - a putaway is
 * "take LPN 000123 to A-04-2", not "move 12 of SKU-1 and 6 of SKU-2 and 3 of
 * SKU-3".
 */
@Injectable()
export class HandlingUnitService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly engine: StockEngineService,
    private readonly numSeq: NumberSequenceService,
    private readonly audit: InventoryAuditService,
    private readonly warehouseScope: WarehouseScopeService,
  ) {}

  async create(orgId: string, userId: string, input: CreateHandlingUnitInput, idempotencyKey: string) {
    if (input.locationId !== undefined) {
      await this.warehouseScope.assertLocationVisible(orgId, userId, input.locationId);
    }

    const created = await this.db.transaction((tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { command: "inventory.handling-unit.create", ...input },
        async () => {
          const huCode = input.huCode ?? (await this.numSeq.next(orgId, "HANDLING_UNIT", tx));
          const [unit] = await tx
            .insert(invHandlingUnits)
            .values({
              orgId,
              huCode,
              kind: input.kind,
              status: "OPEN",
              locationId: input.locationId ?? null,
              parentHuId: null,
              metadata: input.metadata ?? null,
              createdBy: userId,
            })
            .returning({ id: invHandlingUnits.id });

          await this.audit.insert(tx, {
            orgId,
            actorUserId: userId,
            action: "handling_unit.create",
            resourceType: "inv_handling_unit",
            resourceId: String(unit!.id),
            after: { huCode, kind: input.kind, locationId: input.locationId ?? null },
          });

          return { handlingUnitId: unit!.id };
        },
        (stored) => stored as { handlingUnitId: number },
      ),
    );

    return this.detailUnscoped(orgId, created.handlingUnitId);
  }

  /**
   * One handling unit, behind the SAME predicate `list` applies.
   *
   * This took no `userId` — the controller never passed one — so while the list
   * narrowed to the caller's warehouses, the detail behind it answered for any
   * pallet in the organisation, and what it answers with is the unit's whole
   * subtree and its ROLLED-UP CONTENTS: what stock is on that pallet.
   *
   * The children and contents below are deliberately NOT filtered again.
   * Nesting here is physical containment, so a caller entitled to the unit is
   * entitled to what is inside it; filtering the subtree would show somebody a
   * pallet with part of its contents missing, which is a worse answer than
   * either showing it or refusing it.
   */
  async detail(orgId: string, userId: string, handlingUnitId: number): Promise<HandlingUnitDetail> {
    const scope = await this.warehouseScope.resolve(orgId, userId);
    return this.loadDetail(orgId, this.scopePredicate(orgId, scope), handlingUnitId);
  }

  /**
   * The unscoped read, named so nobody routes to it by accident.
   *
   * `create` and `move` end by returning the unit they just acted on, and both
   * have ALREADY called `assertLocationVisible` on the location they were given
   * — so the caller's standing is settled before this runs, and gating it again
   * would refuse an operator the pallet they have just built or just moved.
   */
  private async detailUnscoped(orgId: string, handlingUnitId: number): Promise<HandlingUnitDetail> {
    return this.loadDetail(orgId, null, handlingUnitId);
  }

  private async loadDetail(
    orgId: string,
    gate: SQL | null,
    handlingUnitId: number,
  ): Promise<HandlingUnitDetail> {
    const [unit] = await this.db
      .select({
        id: invHandlingUnits.id,
        huCode: invHandlingUnits.huCode,
        kind: invHandlingUnits.kind,
        status: invHandlingUnits.status,
        locationId: invHandlingUnits.locationId,
        parentHuId: invHandlingUnits.parentHuId,
      })
      .from(invHandlingUnits)
      .where(
        and(
          eq(invHandlingUnits.orgId, orgId),
          eq(invHandlingUnits.id, handlingUnitId),
          ...(gate === null ? [] : [gate]),
        ),
      );
    // Out of scope answers the same as missing, so this is not an oracle for
    // which handling units exist.
    if (!unit) throw new NotFoundException("Not found");

    const children = await this.db
      .select({ id: invHandlingUnits.id })
      .from(invHandlingUnits)
      .where(and(eq(invHandlingUnits.orgId, orgId), eq(invHandlingUnits.parentHuId, handlingUnitId)))
      .orderBy(asc(invHandlingUnits.id));

    const subtree = await this.subtreeIds(this.db, orgId, handlingUnitId);
    const rolledUp = await this.contentsOf(this.db, orgId, subtree);

    return {
      ...unit,
      childIds: children.map((c) => c.id),
      contents: rolledUp.filter((row) => row.handlingUnitId === handlingUnitId),
      rolledUpContents: rolledUp,
    };
  }

  /**
   * Move a handling unit, and everything nested inside it, to a bin.
   *
   * Two engine movements per stock row - out of where it was, into where it is
   * going - under one idempotency key. It is a transfer expressed at the grain a
   * warehouse actually works in, and it is emphatically not a direct write: the
   * ledger records the move line by line, so the pallet's journey is as legible
   * afterwards as any other movement.
   *
   * Nested children come with it and keep `location_id` null, because a child's
   * whereabouts is its parent's. Their *stock rows* still move, since a stock
   * row names a location and those units really are somewhere else now.
   */
  async move(orgId: string, userId: string, handlingUnitId: number, input: MoveHandlingUnitInput, idempotencyKey: string) {
    await this.warehouseScope.assertLocationVisible(orgId, userId, input.toLocationId);

    await this.db.transaction(async (tx) => {
      const [unit] = await tx.execute<{
        id: number; location_id: number | null; parent_hu_id: number | null; status: string;
      }>(sql`
        SELECT id, location_id, parent_hu_id, status
        FROM inv_handling_units
        WHERE org_id = ${orgId} AND id = ${handlingUnitId}
        FOR UPDATE
      `);
      if (!unit) throw new NotFoundException("Not found");
      if (unit.status === "SHIPPED") {
        throw new BadRequestException("This handling unit has shipped and cannot be moved");
      }
      if (unit.parent_hu_id !== null) {
        throw new BadRequestException(
          "This handling unit is nested inside another. Move the outer unit, or un-nest this one first.",
        );
      }

      const [destination] = await tx
        .select({ id: invLocations.id })
        .from(invLocations)
        .where(and(eq(invLocations.orgId, orgId), eq(invLocations.id, input.toLocationId)));
      if (!destination) throw new NotFoundException("Not found");

      const subtree = await this.subtreeIds(tx, orgId, handlingUnitId);
      const contents = await this.contentsOf(tx, orgId, subtree);

      // INV-18. `ownership` is part of `inv_stock_levels`' natural key and was
      // absent from both legs, so every movement defaulted to `OWNED`. A pallet
      // carrying a supplier's cartons was therefore moved by decrementing an
      // `OWNED` row that did not hold them — refused outright where negative
      // stock is forbidden, and where it is allowed, silently converting a
      // consignment into our own stock at the destination while leaving the
      // vendor's units behind in the old bin. Worse, a pallet holding both an
      // owned and a consigned grain of one variant produced two movements that
      // `levelKey` could no longer tell apart, so both landed on the owned row
      // and it was decremented twice.
      const movements = contents.flatMap((row) => [
        {
          transactionType: "TRANSFER_OUT",
          productVariantId: row.productVariantId,
          locationId: row.currentLocationId,
          lotId: row.lotId ?? undefined,
          serialId: row.serialId ?? undefined,
          handlingUnitId: row.handlingUnitId,
          ownership: row.ownership,
          quantityDelta: `-${row.onHand}`,
        },
        {
          transactionType: "TRANSFER_IN",
          productVariantId: row.productVariantId,
          locationId: input.toLocationId,
          lotId: row.lotId ?? undefined,
          serialId: row.serialId ?? undefined,
          handlingUnitId: row.handlingUnitId,
          ownership: row.ownership,
          quantityDelta: row.onHand,
          // The units leave one bin at exactly what they cost in it. Estimating
          // instead is wrong under FIFO the moment an issue crosses a layer.
          costFromMovementIndex: undefined as number | undefined,
        },
      ]);

      // Each inbound leg inherits the cost its own outbound leg turned out to
      // consume. Indexes are pairwise: out at 2n, in at 2n+1.
      for (let i = 1; i < movements.length; i += 2) {
        (movements[i] as { costFromMovementIndex?: number }).costFromMovementIndex = i - 1;
      }

      if (movements.length > 0) {
        await this.engine.executeInTx(tx, orgId, userId, {
          idempotencyKey: `${idempotencyKey}:stock`,
          sourceType: "inv_handling_unit",
          sourceId: String(handlingUnitId),
          reason: `Handling unit moved to location ${input.toLocationId}`,
          movements,
        });
      }

      await tx
        .update(invHandlingUnits)
        .set({ locationId: input.toLocationId, updatedAt: new Date() })
        .where(and(eq(invHandlingUnits.orgId, orgId), eq(invHandlingUnits.id, handlingUnitId)));

      await this.audit.insert(tx, {
        orgId,
        actorUserId: userId,
        action: "handling_unit.move",
        resourceType: "inv_handling_unit",
        resourceId: String(handlingUnitId),
        before: { locationId: unit.location_id },
        after: { locationId: input.toLocationId },
        metadata: { stockRowsMoved: contents.length, subtree },
      });
    });

    await this.engine.invalidateCaches(orgId);
    return this.detailUnscoped(orgId, handlingUnitId);
  }

  /**
   * Put one handling unit inside another, or take it out again.
   *
   * No stock moves: nesting is a statement about which label is on the outside,
   * and the units were already where they are. The two refusals in
   * `handling-unit-rules.ts` are what keep a parent from ever holding stock of
   * its own, which is what makes double-counting impossible rather than merely
   * unlikely.
   */
  async nest(orgId: string, userId: string, handlingUnitId: number, input: NestHandlingUnitInput) {
    /*
     * `create` and `move` both assert the location they write into and `detail`
     * and `list` both narrow through `scopePredicate`. Nesting reached every
     * unit it touched through `node`, which filters on `org_id` and the id
     * alone — so a packer in one building could take a carton off another
     * building's pallet, or hang their own carton onto it.
     *
     * Nothing downstream would have caught it, and here that is a rule rather
     * than an omission: nesting posts NO movements. The units do not go
     * anywhere — a child's whereabouts simply becomes its parent's — so the
     * stock engine is not on this path and `assertLocationsInScope` never runs.
     * What changes is where the system believes somebody else's goods are, and
     * an un-nest writes a location onto the child from a pallet the caller may
     * never have stood next to.
     *
     * BOTH ends, every time, because either alone leaves a door open: gating
     * only the child still lets a caller hang it onto a stranger's pallet, and
     * gating only the parent still lets them strip a stranger's carton off one
     * they own. The parent is asserted BEFORE `assertCanTakeChildren` so a
     * refusal cannot report the parent's kind or status back either.
     */
    const scope = await this.warehouseScope.resolve(orgId, userId);

    return this.db.transaction(async (tx) => {
      // Before the row is read, not after: `node` reports the unit's status,
      // its whereabouts and whether it holds stock, and a gate behind that has
      // already answered the question the caller was not entitled to ask.
      await this.assertUnitVisible(tx, orgId, scope, handlingUnitId);
      const child = await this.node(tx, orgId, handlingUnitId);

      if (input.parentHuId === null) {
        if (child.parentHuId === null) return this.detailIn(tx, orgId, handlingUnitId);
        /*
         * The unit being un-nested FROM, and not a formality. A nested child
         * carries no location of its own, and `scopePredicate` lets an
         * unattributed unit through on purpose — so the child gate above passes
         * for every nested carton in the organisation. Its whereabouts live on
         * the parent, which is therefore the row that actually answers for it,
         * and the parent's `locationId` is what this then writes onto the child.
         */
        await this.assertUnitVisible(tx, orgId, scope, child.parentHuId);
        const parent = await this.node(tx, orgId, child.parentHuId);
        await tx
          .update(invHandlingUnits)
          .set({ parentHuId: null, locationId: parent.locationId, updatedAt: new Date() })
          .where(and(eq(invHandlingUnits.orgId, orgId), eq(invHandlingUnits.id, handlingUnitId)));

        await this.audit.insert(tx, {
          orgId,
          actorUserId: userId,
          action: "handling_unit.unnest",
          resourceType: "inv_handling_unit",
          resourceId: String(handlingUnitId),
          before: { parentHuId: child.parentHuId },
          after: { parentHuId: null, locationId: parent.locationId },
        });
        return this.detailIn(tx, orgId, handlingUnitId);
      }

      if (input.parentHuId === handlingUnitId) {
        throw new BadRequestException("That would put a handling unit inside itself");
      }

      // The destination. Asserting the child alone would still let a caller take
      // a carton they legitimately hold and hang it onto a pallet in a building
      // they cannot see, which re-homes it past every gate this service has.
      await this.assertUnitVisible(tx, orgId, scope, input.parentHuId);
      const parent = await this.node(tx, orgId, input.parentHuId);
      assertCanTakeChildren(parent);
      assertNoCycle(handlingUnitId, await this.ancestorsOf(tx, orgId, input.parentHuId));

      // A child's whereabouts is its parent's, and the schema CHECK refuses a
      // row that claims both.
      await tx
        .update(invHandlingUnits)
        .set({ parentHuId: input.parentHuId, locationId: null, updatedAt: new Date() })
        .where(and(eq(invHandlingUnits.orgId, orgId), eq(invHandlingUnits.id, handlingUnitId)));

      await this.audit.insert(tx, {
        orgId,
        actorUserId: userId,
        action: "handling_unit.nest",
        resourceType: "inv_handling_unit",
        resourceId: String(handlingUnitId),
        before: { parentHuId: child.parentHuId, locationId: child.locationId },
        after: { parentHuId: input.parentHuId },
      });

      return this.detailIn(tx, orgId, handlingUnitId);
    });
  }

  /**
   * The gate every path that puts stock onto a handling unit passes through -
   * receiving, putaway, an adjustment that names one.
   *
   * It is a service method rather than a private helper because receiving is in
   * another module and must ask rather than carry a copy of the rule.
   */
  async assertCanHoldStockInTx(tx: Tx, orgId: string, handlingUnitId: number): Promise<void> {
    assertCanHoldStock(await this.node(tx, orgId, handlingUnitId));
  }

  /**
   * The one definition of "a handling unit I may see".
   *
   * `null` when the caller is unrestricted. A unit with NO location is visible
   * to everybody: an HU is built before it is put anywhere, and hiding one from
   * the person who has just made it would be worse than the leak this closes.
   * That rule is this table's, not a house rule — the labour records exclude an
   * unattributed row instead — which is exactly why it lives in one place and
   * both callers read it rather than each spelling it out.
   */
  /**
   * The object gate, built from the same `scopePredicate` the list and the
   * detail read narrow through — so a unit `nest` will act on is exactly a unit
   * the caller could have found in their list. A second hand-written reading of
   * the rule would be free to drift from it; this one cannot.
   *
   * 404 rather than 403: a "forbidden" on a handling-unit id confirms the unit
   * exists, which turns a probe into an existence oracle (§4). It is also the
   * same answer `node` gives for an id that is not there, so the two are
   * indistinguishable from outside, which is the point.
   */
  private async assertUnitVisible(
    tx: Tx,
    orgId: string,
    scope: number[] | null,
    handlingUnitId: number,
  ): Promise<void> {
    const gate = this.scopePredicate(orgId, scope);
    if (gate === null) return;
    const [visible] = await tx
      .select({ id: invHandlingUnits.id })
      .from(invHandlingUnits)
      .where(and(eq(invHandlingUnits.orgId, orgId), eq(invHandlingUnits.id, handlingUnitId), gate))
      .limit(1);
    if (!visible) throw new NotFoundException("Not found");
  }

  private scopePredicate(orgId: string, scope: number[] | null): SQL | null {
    if (scope === null) return null;
    if (scope.length === 0) return sql`FALSE`;
    return sql`(${invHandlingUnits.locationId} IS NULL OR EXISTS (
            SELECT 1 FROM inv_locations l
            WHERE l.id = ${invHandlingUnits.locationId} AND l.org_id = ${orgId}
              AND l.warehouse_id IN (${sql.join(scope.map((id) => sql`${id}`), sql`, `)})
          ))`;
  }

  async list(orgId: string, userId: string, filters: { locationId?: number; status?: string; rootsOnly?: boolean }) {
    const scope = await this.warehouseScope.resolve(orgId, userId);
    const conditions = [eq(invHandlingUnits.orgId, orgId)];
    if (filters.locationId) conditions.push(eq(invHandlingUnits.locationId, filters.locationId));
    if (filters.status) conditions.push(sql`${invHandlingUnits.status} = ${filters.status}`);
    if (filters.rootsOnly) conditions.push(sql`${invHandlingUnits.parentHuId} IS NULL`);
    const gate = this.scopePredicate(orgId, scope);
    if (gate !== null) conditions.push(gate);

    return this.db
      .select({
        id: invHandlingUnits.id,
        huCode: invHandlingUnits.huCode,
        kind: invHandlingUnits.kind,
        status: invHandlingUnits.status,
        locationId: invHandlingUnits.locationId,
        parentHuId: invHandlingUnits.parentHuId,
        updatedAt: invHandlingUnits.updatedAt,
      })
      .from(invHandlingUnits)
      .where(and(...conditions))
      .orderBy(asc(invHandlingUnits.huCode))
      .limit(100);
  }

  /* ---------------------------------------------------------------- *
   * internals
   * ---------------------------------------------------------------- */

  private async node(executor: Tx | Db, orgId: string, handlingUnitId: number): Promise<HandlingUnitNode> {
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
  private async ancestorsOf(executor: Tx | Db, orgId: string, handlingUnitId: number): Promise<number[]> {
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
  private async subtreeIds(executor: Tx | Db, orgId: string, handlingUnitId: number): Promise<number[]> {
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

  private async contentsOf(
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

  private async detailIn(tx: Tx, orgId: string, handlingUnitId: number): Promise<HandlingUnitDetail> {
    const node = await this.node(tx, orgId, handlingUnitId);
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

    const rolledUp = await this.contentsOf(tx, orgId, await this.subtreeIds(tx, orgId, handlingUnitId));

    return {
      ...row,
      childIds: children.map((c) => c.id),
      contents: node.holdsStock ? rolledUp.filter((r) => r.handlingUnitId === handlingUnitId) : [],
      rolledUpContents: rolledUp,
    };
  }
}
