import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import {
  invRecallEvents,
  invShipments,
  invShipmentLines,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import { StockEngineBatchService } from "../stock-engine/stock-engine-batch.service";
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import type { ListRecallsQueryInput, CreateRecallInput, UpdateRecallInput } from "./dto/quality.schemas";
import {
  WarehouseScopeService,
} from "../stock-engine/warehouse-scope.service";
import { RecallSimulationService } from "./recall-simulation.service";
import { recallInScope } from "./lib/recall-scope";
export type { RecallLineOutcome } from "./lib/recall-executed";
import { createRecall, type RecallCreateDeps } from "./lib/recall-create";

@Injectable()
export class RecallsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly warehouseScope: WarehouseScopeService,
    private readonly engine: StockEngineBatchService,
    private readonly numSeq: NumberSequenceService,
    private readonly audit: InventoryAuditService,
    private readonly simulation: RecallSimulationService,
  ) {}

  async list(orgId: string, userId: string, query: ListRecallsQueryInput) {
    const { status, page, limit } = query;
    const offset = (page - 1) * limit;
    const scope = await this.warehouseScope.forUser(orgId, userId);
    // The resolved scope belongs in the key. Without it the first caller's
    // warehouses are cached and served to the next, which defeats the
    // predicate in both directions.
    const hash = `${scope.key}:${status ?? ""}:${limit}:${offset}`;
    return this.cache.cachedVersioned(
      CACHE_KEYS.invQualityRecallsNamespace(orgId),
      hash,
      async () => {
        const conditions = [eq(invRecallEvents.orgId, orgId)];

        const inScope = recallInScope(orgId, scope);
        if (inScope !== undefined) conditions.push(inScope);

        if (status) conditions.push(eq(invRecallEvents.status, status));
        const where = and(...conditions);
        const [items, countResult] = await Promise.all([
          this.db.query.invRecallEvents.findMany({
            where,
            orderBy: [desc(invRecallEvents.createdAt)],
            limit,
            offset,
            with: { lines: true },
          }),
          this.db.select({ count: sql<number>`count(*)::int` }).from(invRecallEvents).where(where),
        ]);
        return { items, total: countResult[0]?.count ?? 0, page, totalPages: Math.ceil((countResult[0]?.count ?? 0) / limit) };
      },
      CACHE_TTL.SHORT,
    );
  }

  /**
   * One recall, read by id.
   *
   * `list` above resolves the caller's warehouses; this took no `userId`, so it
   * answered on `org_id` and the id alone — and it returns more than the list
   * does, since it goes on to name every shipment the recalled lots went out
   * on. An operator who could not see the recall could still read its whole
   * blast radius, customers included, by walking the ids.
   *
   * A miss is 404, never 403 (§4): telling somebody they are forbidden from
   * recall 91 tells them recall 91 exists.
   */
  async findOne(orgId: string, userId: string, id: number) {
    const scope = await this.warehouseScope.forUser(orgId, userId);
    return this.loadRecallDetail(orgId, id, recallInScope(orgId, scope));
  }

  /**
   * The same detail without the warehouse gate, for the one path entitled to it.
   *
   * `create` ends by handing back the recall it has just raised, and gating that
   * would 404 an operator against their own new record — a recall raised against
   * lots that turn out to hold no stock in their warehouses matches no EXISTS at
   * all. A named private method rather than a flag on `findOne`, so a future
   * route cannot be pointed at the ungated read by accident; this is the shape
   * the ASN detail fix used (`loadAsnUnscoped`), for the same reason.
   */
  private loadRecallUnscoped(orgId: string, id: number) {
    return this.loadRecallDetail(orgId, id, undefined);
  }

  private async loadRecallDetail(orgId: string, id: number, inScope: SQL | undefined) {
    const recall = await this.db.query.invRecallEvents.findFirst({
      where: and(eq(invRecallEvents.id, id), eq(invRecallEvents.orgId, orgId), inScope),
      with: { lines: true },
    });
    if (!recall) throw new NotFoundException("Not found");

    const lotIds = recall.lines
      .map(l => l.lotId)
      .filter((lotId): lotId is number => lotId !== null && lotId !== undefined);
    const serialIds = recall.lines
      .map(l => l.serialId)
      .filter((sid): sid is number => sid !== null && sid !== undefined);

    let affectedShipments: Array<{ shipmentId: number; shipmentNumber: string }> = [];
    if (lotIds.length > 0 || serialIds.length > 0) {
      const lineConditions = [];
      if (lotIds.length > 0) lineConditions.push(inArray(invShipmentLines.lotId, lotIds));
      if (serialIds.length > 0) lineConditions.push(inArray(invShipmentLines.serialId, serialIds));
      const results = await this.db
        .select({ shipmentId: invShipments.id, shipmentNumber: invShipments.shipmentNumber })
        .from(invShipmentLines)
        .innerJoin(invShipments, and(eq(invShipmentLines.shipmentId, invShipments.id), eq(invShipments.orgId, orgId)))
        .where(or(...lineConditions));
      affectedShipments = results;
    }

    return { ...recall, affectedShipments };
  }

  /** @see lib/recall-create.ts */
  async create(orgId: string, userId: string, input: CreateRecallInput, idempotencyKey: string) {
    return createRecall(this.recallDeps, orgId, userId, input, idempotencyKey);
  }

  /**
   * Built explicitly rather than passing `this`: TypeScript will not
   * structurally match a class carrying `private` members to an interface.
   * `reloadUnscopedRecall` is what keeps the ungated read on the service —
   * see the note in `lib/recall-create.ts`.
   */
  private get recallDeps(): RecallCreateDeps {
    return {
      db: this.db,
      cache: this.cache,
      engine: this.engine,
      numSeq: this.numSeq,
      audit: this.audit,
      simulation: this.simulation,
      reloadUnscopedRecall: (orgId, id) => this.loadRecallUnscoped(orgId, id),
    };
  }

  /**
   * Closing or renarrating a recall — the same gate the detail now applies.
   *
   * This one had `userId` in hand and spent it only on the audit row, so an
   * operator holding one warehouse could CLOSE a recall raised against stock in
   * another. Closing is what stops a safety event being chased, so it is a
   * worse thing to reach than the read beside it.
   */
  async update(orgId: string, userId: string, id: number, input: UpdateRecallInput) {
    const scope = await this.warehouseScope.forUser(orgId, userId);
    const recall = await this.db.query.invRecallEvents.findFirst({
      where: and(
        eq(invRecallEvents.id, id),
        eq(invRecallEvents.orgId, orgId),
        recallInScope(orgId, scope),
      ),
    });
    if (!recall) throw new NotFoundException("Not found");
    const patch: Partial<typeof invRecallEvents.$inferInsert> = {};
    if (input.status) {
      patch.status = input.status;
      if (input.status === "CLOSED") patch.closedAt = new Date();
    }
    // `notes` is the client's name for the recall's narrative, and the column
    // holding it is `description`. The field was accepted and then dropped on
    // the floor: the UI's notes editor reported success and stored nothing.
    if (input.notes !== undefined) patch.description = input.notes;
    await this.db.update(invRecallEvents).set(patch)
      .where(and(eq(invRecallEvents.id, id), eq(invRecallEvents.orgId, orgId)));
    await this.audit.insert(this.db, {
      orgId, actorUserId: userId, action: "recall.updated",
      resourceType: "recall", resourceId: String(id),
      before: { status: recall.status }, after: patch,
    });
    await this.cache.invalidateNamespace(CACHE_KEYS.invQualityRecallsNamespace(orgId));
    return this.db.query.invRecallEvents.findFirst({
      where: and(eq(invRecallEvents.id, id), eq(invRecallEvents.orgId, orgId)),
      with: { lines: true },
    });
  }
}
