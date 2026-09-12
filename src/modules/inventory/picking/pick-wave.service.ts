import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
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
import { assertNotAlreadyOnAWave, decideWaveJoin } from "./waveless";
import { assertClaimHeldBy } from "./pick-line";
import type { CreateWaveInput, ListWavesInput, ReassignWaveInput } from "./dto/picking.schemas";
import {
  planWaveLines,
  toWaveLine,
  type WavePlanDeps,
} from "./lib/wave-planning";
import { getWave, listWaves } from "./lib/wave-reads";

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

    /*
     * Every order named must be this organisation's, refused as a whole and
     * before anything is counted.
     *
     * Without this the line-count query below — `eq(orgId) AND soId IN (…)` —
     * silently narrowed to the orders the caller owns and returned a proposal
     * anyway, so `propose` answered where the `createWave` and `joinWave` it
     * precedes would 404: `planWaveLines` has refused an unresolvable `soId`
     * since it was written. A propose that is more permissive than the act it
     * proposes is the worse half of that pair, because it is the half an
     * operator reads. The count it feeds is also wrong in the direction that
     * matters — a wave sized on a subset of its orders.
     *
     * 404, never 403, and unknown and foreign ids are answered identically, so
     * this cannot be read as an existence oracle over another tenant's orders.
     * Stated here rather than shared with `planWaveLines`: the rule has to live
     * in the method that takes the list, or a future reader has to know which
     * of two call paths carries it.
     */
    const owned = await this.db
      .select({ id: invSalesOrders.id })
      .from(invSalesOrders)
      .where(and(eq(invSalesOrders.orgId, orgId), inArray(invSalesOrders.id, input.soIds)));
    const missing = input.soIds.filter((id) => !owned.some((o) => o.id === id));
    if (missing.length > 0) {
      throw new NotFoundException(`No such sales order: ${missing.join(", ")}`);
    }

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


  async createWave(orgId: string, userId: string, input: CreateWaveInput) {
    const { lines, allocations } = await planWaveLines(this.wavePlanDeps, orgId, userId, input);

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
        .values(lines.map((line) => toWaveLine(this.wavePlanDeps, orgId, wave!.id, line, allocations)))
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
    const { lines, allocations } = await planWaveLines(this.wavePlanDeps, orgId, userId, input);

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
        .values(lines.map((line) => toWaveLine(this.wavePlanDeps, orgId, wave.id, line, allocations)))
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

  private get wavePlanDeps(): WavePlanDeps {
    return {
      db: this.db,
      warehouseScope: this.warehouseScope,
      settingsService: this.settingsService,
      soCore: this.soCore,
    };
  }

  /** @see lib/wave-reads.ts — the bodies moved, the route surface did not. */
  async listWaves(orgId: string, userId: string, filters: ListWavesInput) {
    return listWaves(this.db, this.warehouseScope, orgId, userId, filters);
  }

  /** @see lib/wave-reads.ts */
  async getWave(orgId: string, userId: string, pickListId: number) {
    return getWave(this.db, this.warehouseScope, orgId, userId, pickListId);
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
