import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { invPhysicalAudits } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_TTL } from "../../../common/cache/cache-keys";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { StockEngineService } from "../stock-engine/stock-engine.service";
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
import {
  PA_LIST_NAMESPACE,
  cancelAudit,
  createAudit,
  postAudit,
  reviewAudit,
  startAudit,
  updateLines,
  type PhysicalAuditDeps,
} from "./lib/physical-audit-commands";
import type { ListCountsInput, CreateAuditInput, UpdateCountLinesInput } from "./dto/inv-counts.schemas";

@Injectable()
export class InvPhysicalAuditsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly engine: StockEngineService,
    private readonly numSeq: NumberSequenceService,
    private readonly warehouseScope: WarehouseScopeService,
  ) {}

  async listAudits(orgId: string, userId: string, filters: ListCountsInput) {
    const { status, warehouseId, page, limit } = filters;
    const offset = (page - 1) * limit;
    const scope = await this.warehouseScope.forUser(orgId, userId);
    const hash = `${scope.key}:${status ?? ""}:${warehouseId ?? ""}:${limit}:${offset}`;

    return this.cache.cachedVersioned(PA_LIST_NAMESPACE(orgId), hash, async () => {
      const conditions = [eq(invPhysicalAudits.orgId, orgId), scope.warehouse(sql`${invPhysicalAudits.warehouseId}`)];
      if (status) conditions.push(eq(invPhysicalAudits.status, status));
      if (warehouseId) conditions.push(eq(invPhysicalAudits.warehouseId, warehouseId));
      const where = and(...conditions);

      const [items, countResult] = await Promise.all([
        this.db.query.invPhysicalAudits.findMany({
          where,
          orderBy: [desc(invPhysicalAudits.createdAt)],
          limit,
          offset,
          with: { creator: { columns: { id: true, name: true } } },
        }),
        this.db.select({ count: sql<number>`count(*)::int` }).from(invPhysicalAudits).where(where),
      ]);

      const total = countResult[0]?.count ?? 0;
      return { items, total, page, totalPages: Math.ceil(total / limit) };
    }, CACHE_TTL.SHORT);
  }

  /**
   * One audit, behind the SAME warehouse scope `listAudits` applies.
   *
   * Same shape as the cycle-count detail beside it: no caller id in the
   * signature at all, so it answered on `org_id` and the row id while the list
   * above resolves the caller's warehouses. A wall-to-wall audit is the whole
   * stock position of a building at a moment in time, line by line — the thing
   * a warehouse scope exists to keep from leaking sideways.
   *
   * NULL WAREHOUSE — EXCLUDED, following this table's own aggregate. `listAudits`
   * gates through `scope.warehouse(...)`, which is `warehousePredicate` and
   * renders `warehouse_id IN (...)` with no `IS NULL` arm, so an unattributed
   * audit is invisible in the list and invisible here. Deliberately NOT the ASN
   * rule, where the list keeps unattributed rows and the detail had to keep them
   * too. `inv_physical_audits.warehouse_id` is `NOT NULL` today, so this is a
   * rule for the next person rather than a live branch.
   *
   * Out of scope answers 404, never 403 (§4). An empty scope compiles to `FALSE`
   * in the WHERE, which is what the list does with it.
   */
  async getAudit(orgId: string, userId: string, auditId: number) {
    const scope = await this.warehouseScope.forUser(orgId, userId);
    return this.loadAudit(orgId, auditId, [scope.warehouse(sql`${invPhysicalAudits.warehouseId}`)]);
  }

  /**
   * The unscoped read, named so nobody routes to it by accident.
   *
   * `createAudit` returns the audit it has just written and the writer is
   * entitled to see what they wrote; everybody else has already passed
   * `requireAudit` for this id. A named private method rather than a flag on the
   * public one, so a future route cannot be pointed at it.
   */
  private async loadAuditUnscoped(orgId: string, auditId: number) {
    return this.loadAudit(orgId, auditId, []);
  }

  private async loadAudit(orgId: string, auditId: number, scoped: SQL[]) {
    const audit = await this.db.query.invPhysicalAudits.findFirst({
      where: and(eq(invPhysicalAudits.orgId, orgId), eq(invPhysicalAudits.id, auditId), ...scoped),
      with: {
        creator: { columns: { id: true, name: true } },
        lines: {
          with: {
            productVariant: { with: { product: { columns: { id: true, name: true, sku: true } } } },
            location: { columns: { id: true, name: true, code: true } },
          },
        },
      },
    });
    if (!audit) throw new NotFoundException("Physical audit not found");
    return audit;
  }

  /**
   * The gate every mutation funnels through, now carrying the caller.
   *
   * `start`, `updateLines`, `review`, `post` and `cancel` all reach the row
   * through here and none took a caller id, so an auditor scoped to one building
   * could start, rewrite every variance on, post or cancel the wall-to-wall
   * audit of another — and posting one writes stock movements against the real
   * books. Same predicate as `listAudits` (see `getAudit` for the NULL-warehouse
   * rule), same 404 for out of scope.
   */
  /** @see lib/physical-audit-commands.ts */
  async createAudit(orgId: string, userId: string, data: CreateAuditInput) {
    return createAudit(this.auditDeps, orgId, userId, data);
  }

  /** @see lib/physical-audit-commands.ts */
  async startAudit(orgId: string, userId: string, auditId: number) {
    return startAudit(this.auditDeps, orgId, userId, auditId);
  }

  /** @see lib/physical-audit-commands.ts */
  async updateLines(orgId: string, userId: string, auditId: number, data: UpdateCountLinesInput) {
    return updateLines(this.auditDeps, orgId, userId, auditId, data);
  }

  /** @see lib/physical-audit-commands.ts */
  async reviewAudit(orgId: string, userId: string, auditId: number) {
    return reviewAudit(this.auditDeps, orgId, userId, auditId);
  }

  /** @see lib/physical-audit-commands.ts */
  async postAudit(orgId: string, userId: string, auditId: number, idempotencyKey: string) {
    return postAudit(this.auditDeps, orgId, userId, auditId, idempotencyKey);
  }

  /** @see lib/physical-audit-commands.ts */
  async cancelAudit(orgId: string, userId: string, auditId: number) {
    return cancelAudit(this.auditDeps, orgId, userId, auditId);
  }

  /**
   * Built explicitly rather than passing `this`: TypeScript will not
   * structurally match a class carrying `private` members to an interface.
   * `reloadUnscopedAudit` is what keeps the ungated read on the service.
   */
  private get auditDeps(): PhysicalAuditDeps {
    return {
      db: this.db,
      cache: this.cache,
      engine: this.engine,
      numSeq: this.numSeq,
      warehouseScope: this.warehouseScope,
      requireAudit: (orgId, userId, auditId) => this.requireAudit(orgId, userId, auditId),
      reloadUnscopedAudit: (orgId, auditId) => this.loadAuditUnscoped(orgId, auditId),
    };
  }

  private async requireAudit(orgId: string, userId: string, auditId: number) {
    const scope = await this.warehouseScope.forUser(orgId, userId);
    const audit = await this.db.query.invPhysicalAudits.findFirst({
      where: and(
        eq(invPhysicalAudits.orgId, orgId),
        eq(invPhysicalAudits.id, auditId),
        scope.warehouse(sql`${invPhysicalAudits.warehouseId}`),
      ),
      columns: { id: true, status: true, auditNumber: true, warehouseId: true },
    });
    if (!audit) throw new NotFoundException("Physical audit not found");
    return audit;
  }
}
