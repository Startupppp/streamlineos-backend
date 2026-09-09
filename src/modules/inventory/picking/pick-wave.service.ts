import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  invPickLists,
  invPickListLines,
  invSalesOrders,
  invSoLines,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
import { InventorySettingsService } from "../stock-engine/inventory-settings.service";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import { SoCoreService } from "../sales-orders/so-core.service";
import { allocateWaveLines } from "./pick-allocation";
import { assertNotAlreadyOnAWave, decideWaveJoin } from "./waveless";
import { pickConstraintsResolver } from "./pick-allocation-constraints";
import { assertClaimHeldBy } from "./pick-line";
import { PICK_LINE_CLOSED_SQL } from "./pick-exception-policy";
import { queryWaveQueue } from "./pick-wave-queue";
import type { CreateWaveInput, ListWavesInput, ReassignWaveInput } from "./dto/picking.schemas";

@Injectable()
export class PickWaveService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly warehouseScope: WarehouseScopeService,
    private readonly numSeq: NumberSequenceService,
    private readonly settingsService: InventorySettingsService,
    private readonly soCore: SoCoreService,
    private readonly audit: InventoryAuditService,
  ) {}

  /**
   * INV-204 — a wave is one walk across several orders.
   *
   * The existing pick path records what was picked after the fact, one order at
   * a time. That is the wrong shape for a warehouse: a picker walking the same
   * aisle four times because four orders each wanted one item from it is the
   * cost this ticket exists to remove.
   *
   * The header carries no `soId` -- that column stays null for a wave, which is
   * what distinguishes it from a single-order pick -- and each line keeps its
   * own `soLineId` so the goods can be split back to their orders at packing.
   * Nothing about which order a unit belongs to is lost by picking them
   * together.
   *
   * B4, item 1. Every line is now allocated to a location and lot before the
   * picker sees it, through `allocateWaveLines`. A line with no location is a
   * task with no instruction, and it also has no projection grain to write to,
   * so a confirm against one silently left the picked units sellable.
   *
   * R3, item 1. What is left over is now said out loud. A line the allocator
   * cannot resolve is still created — the demand is real and deleting it would
   * lose it — but it comes back in `linesNeedingDecision`, and `confirmPick`
   * refuses to close it against a null location rather than skipping its
   * projection grain. So "no bin" is a state somebody is handed, not a null that
   * travels quietly into the ledger.
   */
  /**
   * NEO-14 - which open wave, if any, these orders should join.
   *
   * Read-only and separate from `createWave` on purpose: the caller asks, decides
   * and then either joins or raises a new wave, and a `createWave` that silently
   * appended to somebody else's wave would be the surprise this whole setting is
   * hedged about. The rule itself is `decideWaveJoin`, one paragraph in
   * `waveless.ts`.
   */
  async proposeWaveJoin(orgId: string, userId: string, input: CreateWaveInput) {
    await this.warehouseScope.assertWarehouseVisible(orgId, userId, input.warehouseId);
    const settings = await this.settingsService.get(orgId);

    const lineCount = await this.db
      .select({ id: invSoLines.id })
      .from(invSoLines)
      .where(and(eq(invSoLines.orgId, orgId), inArray(invSoLines.soId, input.soIds)));

    const openWaves = await this.db.execute<{
      id: number; warehouse_id: number | null; status: string;
      line_count: number; lines_picked: number;
    }>(sql`
      SELECT pl.id, pl.warehouse_id, pl.status,
             COUNT(pll.id)::int AS line_count,
             COUNT(pll.id) FILTER (WHERE pll.quantity_picked::numeric > 0)::int AS lines_picked
      FROM inv_pick_lists pl
      LEFT JOIN inv_pick_list_lines pll ON pll.org_id = pl.org_id AND pll.pick_list_id = pl.id
      WHERE pl.org_id = ${orgId}
        AND pl.warehouse_id = ${input.warehouseId}
        AND pl.status = 'PENDING'
      GROUP BY pl.id, pl.warehouse_id, pl.status
      ORDER BY pl.id
      LIMIT 50
    `);

    return decideWaveJoin({
      wavelessPicking: settings.wavelessPicking,
      maxLines: settings.wavelessMaxLines,
      warehouseId: input.warehouseId,
      newLineCount: lineCount.length,
      openWaves: openWaves.map((wave) => ({
        id: Number(wave.id),
        warehouseId: wave.warehouse_id === null ? null : Number(wave.warehouse_id),
        status: wave.status,
        lineCount: Number(wave.line_count),
        linesPicked: Number(wave.lines_picked),
      })),
    });
  }

  /**
   * The work `createWave` and `joinWave` share: are these orders pickable from
   * this building, what are their lines, and where is each line's stock.
   *
   * Extracted rather than copied. A join that validated orders differently from
   * a create would be a second definition of "ready to pick", and the two would
   * drift the first time one of them was fixed.
   */
  private async planWaveLines(orgId: string, userId: string, input: CreateWaveInput) {
    await this.warehouseScope.assertWarehouseVisible(orgId, userId, input.warehouseId);

    const orders = await this.db.query.invSalesOrders.findMany({
      where: and(
        eq(invSalesOrders.orgId, orgId),
        inArray(invSalesOrders.id, input.soIds),
      ),
      columns: { id: true, status: true, warehouseId: true },
    });

    const missing = input.soIds.filter((id) => !orders.some((o) => o.id === id));
    if (missing.length > 0) {
      throw new NotFoundException(`No such sales order: ${missing.join(", ")}`);
    }

    // Reported together rather than one at a time: a picker told to fix a wave
    // of twelve orders should not discover the problems twelve waves later.
    const notPickable = orders.filter(
      (o) => !["CONFIRMED", "RESERVED", "PARTIALLY_RESERVED"].includes(o.status),
    );
    if (notPickable.length > 0) {
      throw new BadRequestException(
        `These orders are not ready to pick: ${notPickable.map((o) => `${o.id} (${o.status})`).join(", ")}`,
      );
    }
    const wrongWarehouse = orders.filter(
      (o) => o.warehouseId !== null && o.warehouseId !== input.warehouseId,
    );
    if (wrongWarehouse.length > 0) {
      throw new BadRequestException(
        `These orders ship from a different warehouse: ${wrongWarehouse.map((o) => o.id).join(", ")}`,
      );
    }

    const lines = await this.db
      .select({
        soLineId: invSoLines.id,
        soId: invSoLines.soId,
        productVariantId: invSoLines.productVariantId,
        quantity: invSoLines.quantity,
      })
      .from(invSoLines)
      .where(
        and(eq(invSoLines.orgId, orgId), inArray(invSoLines.soId, input.soIds)),
      )
      .orderBy(asc(invSoLines.productVariantId), asc(invSoLines.id));

    if (lines.length === 0) {
      throw new BadRequestException("Those orders have no lines to pick");
    }

    const settings = await this.settingsService.get(orgId);
    const constraintsFor = pickConstraintsResolver(this.db, this.settingsService, orgId);
    const allocations = await allocateWaveLines(
      this.db,
      orgId,
      lines.map((l) => ({
        soLineId: l.soLineId,
        soId: l.soId,
        productVariantId: l.productVariantId,
        quantity: String(l.quantity),
      })),
      // D2. Constraints per order, cached per order. A wave spans several
      // customers, and the shelf-life floor is a term of one agreement — see
      // `pick-allocation-constraints.ts`. Without this the whole picking module
      // allocated with no near-expiry tier and no floor, so a wave could promise
      // a lot auto-reserve had refused for the same customer minutes earlier.
      async (productVariantId, quantity, soId) =>
        this.soCore.findAvailableLotForLine(
          orgId,
          productVariantId,
          input.warehouseId,
          quantity,
          settings.reservationStrategy,
          settings.expiryReservationPolicy,
          await constraintsFor(soId),
        ),
    );

    return { lines, allocations };
  }

  /** The wave line as it is stored, on the grain the allocator resolved. */
  private toWaveLine(
    orgId: string,
    pickListId: number,
    line: { soLineId: number; productVariantId: number; quantity: unknown },
    allocations: Awaited<ReturnType<PickWaveService["planWaveLines"]>>["allocations"],
  ) {
    const at = allocations.get(line.soLineId);
    const allocated = at?.status === "ALLOCATED" ? at : null;
    return {
      orgId,
      pickListId,
      soLineId: line.soLineId,
      productVariantId: line.productVariantId,
      locationId: allocated?.locationId ?? null,
      lotId: allocated?.lotId ?? null,
      serialId: allocated?.serialId ?? null,
      // NEO-4. The wave line stands on the same grain the allocation
      // resolved, or the pick empties a different row than the promise
      // holds.
      handlingUnitId: allocated?.handlingUnitId ?? null,
      quantityToPick: String(line.quantity),
      quantityPicked: "0",
    };
  }

  async createWave(orgId: string, userId: string, input: CreateWaveInput) {
    const { lines, allocations } = await this.planWaveLines(orgId, userId, input);

    const pickNumber = await this.numSeq.next(orgId, "PICK_LIST");

    return this.db.transaction(async (tx) => {
      const [wave] = await tx
        .insert(invPickLists)
        .values({
          orgId,
          pickNumber,
          // Null: this pick belongs to no single order, which is the whole
          // point of a wave.
          soId: null,
          warehouseId: input.warehouseId,
          status: "PENDING",
          createdBy: userId,
        })
        .returning();

      const inserted = await tx
        .insert(invPickListLines)
        .values(lines.map((line) => this.toWaveLine(orgId, wave!.id, line, allocations)))
        .returning({ id: invPickListLines.id, soLineId: invPickListLines.soLineId });

      // R3, item 1. Named rather than counted. A wave that comes back "3 lines
      // could not be allocated" leaves the planner to find which three by
      // reading the whole wave; the ids are what a client needs to put those
      // lines in front of somebody, and the count is derived from them.
      const needsDecision = inserted
        .filter(
          (row) =>
            row.soLineId !== null &&
            allocations.get(row.soLineId)?.status !== "ALLOCATED",
        )
        .map((row) => row.id);

      await this.audit.insert(tx, {
        orgId,
        actorUserId: userId,
        action: "inventory.pick.wave_created",
        resourceType: "inv_pick_lists",
        resourceId: String(wave!.id),
        after: { pickNumber, warehouseId: input.warehouseId, soIds: input.soIds },
        metadata: {
          lineCount: lines.length,
          unallocatedLines: needsDecision.length,
          linesNeedingDecision: needsDecision,
        },
      });

      return {
        pickListId: wave!.id,
        pickNumber,
        orderCount: input.soIds.length,
        lineCount: lines.length,
        // Surfaced rather than swallowed: a wave whose lines have nowhere to be
        // picked from is a stock problem the picker cannot solve at the shelf.
        unallocatedLines: needsDecision.length,
        linesNeedingDecision: needsDecision,
      };
    });
  }

  /**
   * NEO-14 — actually join the wave `proposeWaveJoin` named.
   *
   * The propose endpoint has always existed and its own comment promised that
   * "the caller then either posts to the join route or raises a new wave".
   * There was no join route: NEO-14 shipped a decision with nothing to act on,
   * which is why no wave had ever been joined. This is that route.
   *
   * ## The decision is taken again here, not trusted
   *
   * `proposeWaveJoin` answers a question about a moment that has passed. Between
   * the proposal and this call a picker can claim the wave and confirm a line,
   * and joining it then is precisely the "adding work behind somebody who is
   * already walking" that `waveless.ts` refuses in four conditions. So the rule
   * is re-run against *this* wave and its refusal is the caller's answer — the
   * proposal is a hint, and this is the gate.
   *
   * ## A line joins exactly once
   *
   * `assertNotAlreadyOnAWave` was written with NEO-14 and had no caller either.
   * The reservation already stands against the sales-order line; joining does
   * not make a second one, and a line on two waves is the same promise on the
   * floor twice. Refused rather than deduplicated: a caller asking for it has
   * lost track of something.
   */
  async joinWave(orgId: string, userId: string, pickListId: number, input: CreateWaveInput) {
    /*
     * ## The orders are planned before the wave is looked up, and the order is
     * the point
     *
     * `planWaveLines` opens with `assertWarehouseVisible` on
     * `input.warehouseId`, so running it first is what puts the warehouse gate
     * ahead of every query about the wave. It used to run second, and the two
     * refusals were distinguishable: a caller naming a warehouse they hold
     * nothing in got "Pick wave not found" when the id was free and "Not found"
     * when it was taken. Both are 404s, which is why this survived a reading —
     * but the pair answers "does pick list N exist in this organisation" for
     * every id, in a module whose whole point is that an operator sees only
     * their own buildings. §4 calls that an existence oracle and it does not
     * stop being one because the status codes agree.
     *
     * The wave's own warehouse needs no separate assert: `decideWaveJoin`
     * refuses unless `wave.warehouseId === input.warehouseId`, so a wave in a
     * building the caller does not hold cannot be joined by naming one they do.
     * That equality is a picking rule — a wave is a walk through one building —
     * and the visibility gate rides on it deliberately rather than by accident,
     * which is why it is written down here.
     *
     * The cost is that a caller who names a pick list that does not exist pays
     * for the planning first. That is a bad id doing a little more work, not a
     * correct call doing any.
     */
    const { lines, allocations } = await this.planWaveLines(orgId, userId, input);

    const wave = await this.db.query.invPickLists.findFirst({
      where: and(eq(invPickLists.id, pickListId), eq(invPickLists.orgId, orgId)),
      columns: { id: true, warehouseId: true, status: true, pickNumber: true },
    });
    if (!wave) throw new NotFoundException("Pick wave not found");

    const [shape] = await this.db.execute<{ line_count: number; lines_picked: number }>(sql`
      SELECT COUNT(*)::int AS line_count,
             COUNT(*) FILTER (WHERE quantity_picked::numeric > 0)::int AS lines_picked
        FROM inv_pick_list_lines
       WHERE org_id = ${orgId} AND pick_list_id = ${pickListId}
    `);

    const settings = await this.settingsService.get(orgId);
    const decision = decideWaveJoin({
      wavelessPicking: settings.wavelessPicking,
      maxLines: settings.wavelessMaxLines,
      warehouseId: input.warehouseId,
      newLineCount: lines.length,
      openWaves: [
        {
          id: wave.id,
          warehouseId: wave.warehouseId,
          status: wave.status,
          lineCount: Number(shape!.line_count),
          linesPicked: Number(shape!.lines_picked),
        },
      ],
    });
    if (!decision.join || decision.waveId !== wave.id) {
      throw new BadRequestException(decision.reason ?? "These orders cannot join that wave");
    }

    const onAWave = await this.db.execute<{ so_line_id: number }>(sql`
      SELECT DISTINCT pll.so_line_id
        FROM inv_pick_list_lines pll
       WHERE pll.org_id = ${orgId}
         AND pll.so_line_id IN (${sql.join(
           lines.map((l) => sql`${l.soLineId}`),
           sql`, `,
         )})
    `);
    const already = new Set(onAWave.map((row) => Number(row.so_line_id)));
    for (const line of lines) assertNotAlreadyOnAWave(line.soLineId, already);

    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(invPickListLines)
        .values(lines.map((line) => this.toWaveLine(orgId, wave.id, line, allocations)))
        .returning({ id: invPickListLines.id, soLineId: invPickListLines.soLineId });

      const needsDecision = inserted
        .filter(
          (row) =>
            row.soLineId !== null &&
            allocations.get(row.soLineId)?.status !== "ALLOCATED",
        )
        .map((row) => row.id);

      await this.audit.insert(tx, {
        orgId,
        actorUserId: userId,
        action: "inventory.pick.wave_joined",
        resourceType: "inv_pick_lists",
        resourceId: String(wave.id),
        after: { pickNumber: wave.pickNumber, warehouseId: input.warehouseId, soIds: input.soIds },
        metadata: {
          addedLines: lines.length,
          unallocatedLines: needsDecision.length,
          linesNeedingDecision: needsDecision,
        },
      });

      return {
        pickListId: wave.id,
        pickNumber: wave.pickNumber,
        joined: true,
        addedOrderCount: input.soIds.length,
        addedLineCount: lines.length,
        lineCount: Number(shape!.line_count) + lines.length,
        unallocatedLines: needsDecision.length,
        linesNeedingDecision: needsDecision,
      };
    });
  }

  /**
   * B4, item 5 — the workbench's queue.
   *
   * Warehouse-scoped like every other inventory list, and the scope resolution
   * lives here rather than in the query file so the query stays a query.
   */
  async listWaves(orgId: string, userId: string, filters: ListWavesInput) {
    const scope = await this.warehouseScope.resolve(orgId, userId);
    return queryWaveQueue(this.db, orgId, userId, filters, (column) =>
      this.warehouseScope.warehousePredicate(scope, column),
    );
  }

  /**
   * The wave in the order a picker should walk it.
   *
   * Sorted by location code, because a pick list that jumps around the building
   * is the same wasted walk the wave was supposed to remove. Lines with no
   * location yet sort last: they need a decision rather than a walk.
   *
   * B5. Each line carries `line_closed` from `PICK_LINE_CLOSED_SQL` rather than
   * leaving the workbench to re-derive it from the quantities and the reason.
   * The rule now has three clauses -- picked in full, a closing reason, and a
   * reviewer's signature where one is required -- and a client copy of it would
   * be a fourth place for it to drift, showing a picker a finished row the server
   * still considers outstanding.
   *
   * R3. `needs_decision` is the other half of that: outstanding work with nowhere
   * to walk to. Derived here for the same reason `line_closed` is -- a client
   * inferring it from a null `location_id` would call a line that has already
   * been short-closed a decision somebody still owes.
   */
  async getWave(orgId: string, userId: string, pickListId: number) {
    const wave = await this.db.query.invPickLists.findFirst({
      where: and(eq(invPickLists.id, pickListId), eq(invPickLists.orgId, orgId)),
    });
    if (!wave) throw new NotFoundException("Pick list not found");
    if (wave.warehouseId !== null) {
      await this.warehouseScope.assertWarehouseVisible(orgId, userId, wave.warehouseId);
    }

    const lines = await this.db.execute<{
      id: number;
      so_line_id: number | null;
      so_number: string | null;
      product_variant_id: number;
      sku: string;
      variant_name: string;
      location_id: number | null;
      location_code: string | null;
      lot_id: number | null;
      lot_number: string | null;
      serial_id: number | null;
      serial_number: string | null;
      quantity_to_pick: string;
      quantity_picked: string;
      exception_reason: string | null;
      exception_notes: string | null;
      exception_status: string | null;
      exception_resolution: string | null;
      exception_owner_id: string | null;
      exception_owner_name: string | null;
      exception_location_code: string | null;
      substitute_variant_id: number | null;
      substitute_sku: string | null;
      substitute_quantity: string | null;
      line_closed: boolean;
      needs_decision: boolean;
    }>(sql`
      SELECT pll.id,
             pll.so_line_id,
             so.so_number,
             pll.product_variant_id,
             v.sku,
             v.name AS variant_name,
             pll.location_id,
             l.code AS location_code,
             pll.lot_id,
             lot.lot_number,
             pll.serial_id,
             ser.serial_number,
             pll.quantity_to_pick,
             pll.quantity_picked,
             pll.exception_reason,
             pll.exception_notes,
             pll.exception_status,
             pll.exception_resolution,
             pll.exception_owner_id,
             owner.name AS exception_owner_name,
             found.code AS exception_location_code,
             pll.substitute_variant_id,
             sub.sku AS substitute_sku,
             pll.substitute_quantity,
             ${PICK_LINE_CLOSED_SQL} AS line_closed,
             (pll.location_id IS NULL AND NOT ${PICK_LINE_CLOSED_SQL}) AS needs_decision
      FROM inv_pick_list_lines pll
      JOIN inv_product_variants v
        ON v.org_id = pll.org_id AND v.id = pll.product_variant_id
      LEFT JOIN inv_product_variants sub
        ON sub.org_id = pll.org_id AND sub.id = pll.substitute_variant_id
      LEFT JOIN inv_locations l
        ON l.org_id = pll.org_id AND l.id = pll.location_id
      LEFT JOIN inv_locations found
        ON found.org_id = pll.org_id AND found.id = pll.exception_location_id
      LEFT JOIN inv_lots lot
        ON lot.org_id = pll.org_id AND lot.id = pll.lot_id
      LEFT JOIN inv_serial_numbers ser
        ON ser.org_id = pll.org_id AND ser.id = pll.serial_id
      LEFT JOIN inv_so_lines sol
        ON sol.org_id = pll.org_id AND sol.id = pll.so_line_id
      LEFT JOIN inv_sales_orders so
        ON so.org_id = sol.org_id AND so.id = sol.so_id
      -- Explicitly projected: the global users table still holds authentication
      -- secrets and legacy payroll columns, so nothing here reads it through a
      -- relation.
      LEFT JOIN users owner ON owner.id = pll.exception_owner_id
      WHERE pll.org_id = ${orgId} AND pll.pick_list_id = ${pickListId}
      ORDER BY l.code NULLS LAST, pll.id
    `);

    return { ...wave, lines };
  }

  /**
   * B4, item 3 — claim, abandon, reassign.
   *
   * All three are conditional single statements, and that is what makes them
   * safe to retry and impossible to double-count. Claiming fires only while the
   * wave is unclaimed, so the loser of a race is told it is taken rather than
   * quietly sharing it; abandoning fires only on the holder's own claim;
   * reassigning refuses a wave that is already finished. None of them touches a
   * quantity, so no repetition of any of them can move stock.
   */
  async claimWave(orgId: string, userId: string, pickListId: number) {
    const wave = await this.assertWaveVisible(orgId, userId, pickListId);
    if (wave.status === "COMPLETED" || wave.status === "CANCELLED") {
      throw new BadRequestException("This wave is already finished");
    }

    const claimed = await this.db.transaction(async (tx) => {
      const rows = await tx.execute<{ id: number }>(sql`
        UPDATE inv_pick_lists
           SET assigned_to = ${userId}, claimed_at = NOW(), updated_at = NOW()
         WHERE org_id = ${orgId} AND id = ${pickListId} AND assigned_to IS NULL
        RETURNING id
      `);
      if (rows.length > 0) {
        await this.audit.insert(tx, {
          orgId,
          actorUserId: userId,
          action: "inventory.pick.wave_claimed",
          resourceType: "inv_pick_lists",
          resourceId: String(pickListId),
          after: { assignedTo: userId },
        });
      }
      return rows.length > 0;
    });

    // A claim the caller already holds is not a failure: retrying a claim is
    // exactly what a flaky warehouse network produces.
    if (!claimed) assertClaimHeldBy(wave.assignedTo, userId);

    return { pickListId, assignedTo: userId, claimed };
  }

  async abandonWave(orgId: string, userId: string, pickListId: number) {
    const wave = await this.assertWaveVisible(orgId, userId, pickListId);
    assertClaimHeldBy(wave.assignedTo, userId);

    const released = await this.db.transaction(async (tx) => {
      const rows = await tx.execute<{ id: number }>(sql`
        UPDATE inv_pick_lists
           SET assigned_to = NULL, claimed_at = NULL, updated_at = NOW()
         WHERE org_id = ${orgId} AND id = ${pickListId} AND assigned_to = ${userId}
        RETURNING id
      `);
      if (rows.length > 0) {
        await this.audit.insert(tx, {
          orgId,
          actorUserId: userId,
          action: "inventory.pick.wave_abandoned",
          resourceType: "inv_pick_lists",
          resourceId: String(pickListId),
          before: { assignedTo: userId },
          after: { assignedTo: null },
        });
      }
      return rows.length > 0;
    });

    // What was already picked stays picked. Abandoning gives up the walk, not
    // the goods already in the tote — unwinding those is what an exception is
    // for, and inventing a second unwind here would be a silent stock movement.
    return { pickListId, assignedTo: null, released };
  }

  async reassignWave(
    orgId: string,
    userId: string,
    pickListId: number,
    input: ReassignWaveInput,
  ) {
    const wave = await this.assertWaveVisible(orgId, userId, pickListId);
    if (wave.status === "COMPLETED" || wave.status === "CANCELLED") {
      throw new BadRequestException("This wave is already finished");
    }

    const [member] = await this.db.execute<{ user_id: string }>(sql`
      SELECT user_id FROM organization_members
       WHERE org_id = ${orgId} AND user_id = ${input.assigneeUserId}
         AND status = 'ACTIVE'
    `);
    // 404 rather than 403: a caller learning that a given user id does exist in
    // some other organisation is an existence oracle.
    if (!member) throw new NotFoundException("That person is not a member of this organisation");

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE inv_pick_lists
           SET assigned_to = ${input.assigneeUserId}, claimed_at = NOW(), updated_at = NOW()
         WHERE org_id = ${orgId} AND id = ${pickListId}
      `);
      await this.audit.insert(tx, {
        orgId,
        actorUserId: userId,
        action: "inventory.pick.wave_reassigned",
        resourceType: "inv_pick_lists",
        resourceId: String(pickListId),
        before: { assignedTo: wave.assignedTo },
        after: { assignedTo: input.assigneeUserId },
      });
      return { pickListId, assignedTo: input.assigneeUserId };
    });
  }

  private async assertWaveVisible(orgId: string, userId: string, pickListId: number) {
    const wave = await this.db.query.invPickLists.findFirst({
      where: and(eq(invPickLists.id, pickListId), eq(invPickLists.orgId, orgId)),
      columns: { id: true, status: true, warehouseId: true, assignedTo: true },
    });
    if (!wave) throw new NotFoundException("Pick list not found");
    if (wave.warehouseId !== null) {
      await this.warehouseScope.assertWarehouseVisible(orgId, userId, wave.warehouseId);
    }
    return wave;
  }
}
