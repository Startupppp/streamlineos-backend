import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { isUniqueViolation } from "../../../common/db/postgres-error";
import {
  invProjects,
  invProjectRequirements,
  invProductVariants,
  invProducts,
  invStockLevels,
  invStockReservations,
  invWarehouses,
  invLocations,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import { InventorySettingsService } from "../stock-engine/inventory-settings.service";
import { ReservationService } from "../stock-engine/reservation.service";
import { WarehouseScopeService, type WarehouseScope } from "../stock-engine/warehouse-scope.service";
import { availableQtySql, availableQtySumSql } from "../stock-engine/available-sql";
import { addDec, cmpDec } from "../stock-engine/decimal";
import { PROJECT_REQUIREMENT_SOURCE } from "./inv-projects.constants";
export { PROJECT_REQUIREMENT_SOURCE } from "./inv-projects.constants";
import { assessCoverage, type RiskReason } from "./lib/coverage";
import {
  assertHoldsInScope,
  heldByLocation,
  resolveReservationLocation,
} from "./lib/reservation-location";
import type {
  CreateProjectInput,
  CreateRequirementInput,
  ListProjectsInput,
  ReserveRequirementInput,
  UpdateProjectInput,
  UpdateRequirementInput,
} from "./dto/inv-projects.schemas";



/** Statuses that mean the project is still consuming material. */
const OPEN_PROJECT_STATUSES = ["PLANNING", "ACTIVE", "ON_HOLD"] as const;
/** Statuses that mean the line still wants stock. */
const OPEN_REQUIREMENT_STATUSES = ["DRAFT", "REQUESTED", "RESERVED", "PARTIALLY_FULFILLED"] as const;

function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, (c) => `\\${c}`);
}

export interface RequirementCoverage {
  requirementId: number;
  requiredQty: string;
  reservedQty: string;
  fulfilledQty: string;
  /** required − reserved − fulfilled, floored at zero. What is still unmet. */
  shortfallQty: string;
  /** Availability at the named store, or org-wide when the line names none. */
  availableQty: string;
  /**
   * Whether this line is heading for a miss.
   *
   * Derived on every read rather than stored: it is a function of today's date,
   * today's availability and today's reservations, and all three move without
   * anybody touching the requirement. A stored flag would be wrong within a day
   * and nobody would know which day.
   */
  atRisk: boolean;
  riskReason: RiskReason;
}

/**
 * B1 — construction projects, and the deliberate answer to "why is this not
 * warehouse-scoped?".
 *
 * A warehouse-scope census reads this file as ten un-gated candidates. Nine of
 * them are un-gated **on purpose**, and this is where that is written down so
 * the next census does not raise them again.
 *
 * **A project is a demand source, not a place.** `inv_projects` carries no
 * warehouse column and is not missing one: its own schema docblock says
 * "material for a site is reserved out of the dark store that will serve it",
 * and `zone` exists precisely so *several* dark stores can be ranked to cover a
 * shortage. The warehouse lives one level down, on the requirement, and it is
 * nullable on purpose — "we need 200 bags by Friday" is a real requirement
 * before anybody has decided where they come from. A project is therefore not a
 * per-warehouse object at all; it is an org-wide planning object that DRAWS FROM
 * warehouses, line by line, and different lines on one site legitimately name
 * different stores or none.
 *
 * Scoping the project header through its requirements was considered and
 * rejected on evidence, not taste. `NULL IN (…)` is NULL — the rule this module
 * uses everywhere — so a project whose lines name no store yet would be
 * invisible to exactly the planner whose job is to give those lines a store, and
 * a project with no lines at all (every project, for the first second of its
 * life) would be invisible to the person who just created it, including to the
 * `addRequirement` call that would have made it visible. That is not a tail to
 * patch around; it is a deadlock, and it is the schema telling us the header is
 * not the warehouse-attributed grain.
 *
 * **What a scoped operator can see here, and why that is correct.** Everything
 * on the planning surface: every site in the organisation, its client, its
 * dates, its status, every material line, and the name of the store a line is
 * pointed at. A store's name, code and zone are org structure, not stock — the
 * project row already carries a `zone` drawn from the same vocabulary — and a
 * line that read "expected from ▮▮▮" would be unreadable to the planner it is
 * for. Availability likewise stays the org-wide number: `coverageFor` answers
 * "can this demand be met", which is the same question `/:soId/atp` answers, and
 * that surface settled it the same way — the number stays org-wide, the gate
 * goes on the claim.
 *
 * **What a scoped operator cannot do.** Take or give back a hold on stock
 * standing in a building they are not assigned to. That is the one thing in this
 * file that is not planning, and the controller already says so in words: reserve
 * and release carry `inventory:stock:reserve` and not the project key, because
 * "holding stock is a claim on the warehouse, and whoever may make that claim is
 * a warehouse decision, not a project one". Those two methods are gated on the
 * bin the stock actually stands in — see `assertHoldsInScope`.
 *
 * `projects-warehouse-scope.spec.ts` pins both halves: the gate on the two
 * claims, and the *absence* of a gate on the nine planning surfaces.
 */
@Injectable()
export class InvProjectsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: InventoryAuditService,
    private readonly settings: InventorySettingsService,
    private readonly reservations: ReservationService,
    private readonly warehouseScope: WarehouseScopeService,
  ) {}

  /**
   * B1 — every project surface is behind the `materials` pack.
   *
   * A 404 rather than a 403: with the pack off this module is not part of the
   * product the organisation is running, and "you may not see this" would imply
   * there is something to see. Same reasoning the quick-commerce ingest uses.
   */
  private async assertPack(orgId: string): Promise<void> {
    const settings = await this.settings.get(orgId);
    if (!settings.packs.materials) {
      throw new NotFoundException({
        code: "MATERIALS_PACK_DISABLED",
        message: "Construction projects are part of the materials pack, which is not enabled for this organisation.",
      });
    }
  }

  async listProjects(orgId: string, filters: ListProjectsInput) {
    await this.assertPack(orgId);
    const { page, limit } = filters;
    const offset = (page - 1) * limit;

    const conds = [eq(invProjects.orgId, orgId), isNull(invProjects.deletedAt)];
    if (filters.status) conds.push(eq(invProjects.status, filters.status));
    if (filters.openOnly) conds.push(inArray(invProjects.status, [...OPEN_PROJECT_STATUSES]));
    if (filters.zone) conds.push(eq(invProjects.zone, filters.zone));
    if (filters.clientId) conds.push(eq(invProjects.clientId, filters.clientId));
    if (filters.search) {
      const term = `%${escapeLike(filters.search)}%`;
      conds.push(or(ilike(invProjects.name, term), ilike(invProjects.code, term))!);
    }
    const where = and(...conds);

    const [items, countRows] = await Promise.all([
      this.db
        .select({
          id: invProjects.id,
          code: invProjects.code,
          name: invProjects.name,
          clientId: invProjects.clientId,
          city: invProjects.city,
          zone: invProjects.zone,
          status: invProjects.status,
          startsOn: invProjects.startsOn,
          endsOn: invProjects.endsOn,
          siteContactName: invProjects.siteContactName,
          createdAt: invProjects.createdAt,
          updatedAt: invProjects.updatedAt,
          // One correlated aggregate per project rather than a second round trip
          // per row: the list is the screen a planner scans, and "how many lines
          // are still open" is the number they scan for.
          openRequirements: sql<number>`(
            SELECT count(*)::int FROM inv_project_requirements r
            WHERE r.org_id = ${invProjects.orgId} AND r.project_id = ${invProjects.id}
              AND r.status IN ('DRAFT', 'REQUESTED', 'RESERVED', 'PARTIALLY_FULFILLED')
          )`,
          overdueRequirements: sql<number>`(
            SELECT count(*)::int FROM inv_project_requirements r
            WHERE r.org_id = ${invProjects.orgId} AND r.project_id = ${invProjects.id}
              AND r.status IN ('DRAFT', 'REQUESTED', 'RESERVED', 'PARTIALLY_FULFILLED')
              AND r.required_by IS NOT NULL AND r.required_by < CURRENT_DATE
          )`,
        })
        .from(invProjects)
        .where(where)
        .orderBy(desc(invProjects.updatedAt))
        .limit(limit)
        .offset(offset),
      this.db.select({ count: sql<number>`count(*)::int` }).from(invProjects).where(where),
    ]);

    const total = countRows[0]?.count ?? 0;
    return { items, total, page, totalPages: Math.ceil(total / limit) };
  }

  async getProject(orgId: string, projectId: number) {
    await this.assertPack(orgId);
    const project = await this.db.query.invProjects.findFirst({
      where: and(
        eq(invProjects.id, projectId),
        eq(invProjects.orgId, orgId),
        isNull(invProjects.deletedAt),
      ),
      columns: {
        id: true, code: true, name: true, clientId: true, siteAddress: true, city: true,
        zone: true, siteContactName: true, siteContactPhone: true, status: true,
        startsOn: true, endsOn: true, notes: true, createdAt: true, updatedAt: true,
      },
    });
    // Cross-tenant and missing look the same from outside, per §4.
    if (!project) throw new NotFoundException("Project not found");

    const requirements = await this.listRequirementRows(orgId, projectId);
    const coverage = await this.coverageFor(orgId, requirements);
    const byId = new Map(coverage.map((c) => [c.requirementId, c]));

    return {
      ...project,
      requirements: requirements.map((r) => ({ ...r, coverage: byId.get(r.id) ?? null })),
    };
  }

  private async listRequirementRows(orgId: string, projectId: number) {
    return this.db
      .select({
        id: invProjectRequirements.id,
        projectId: invProjectRequirements.projectId,
        productVariantId: invProjectRequirements.productVariantId,
        warehouseId: invProjectRequirements.warehouseId,
        requiredQty: invProjectRequirements.requiredQty,
        fulfilledQty: invProjectRequirements.fulfilledQty,
        requiredBy: invProjectRequirements.requiredBy,
        status: invProjectRequirements.status,
        notes: invProjectRequirements.notes,
        createdAt: invProjectRequirements.createdAt,
        variantSku: invProductVariants.sku,
        variantName: invProductVariants.name,
        productId: invProducts.id,
        productName: invProducts.name,
        productSku: invProducts.sku,
        brand: invProducts.brand,
        materialGrade: invProducts.materialGrade,
        dimensionLabel: invProducts.dimensionLabel,
        imageUrl: invProducts.imageUrl,
        leadTimeDays: invProducts.leadTimeDays,
        warehouseName: invWarehouses.name,
        warehouseCode: invWarehouses.code,
        warehouseZone: invWarehouses.zone,
      })
      .from(invProjectRequirements)
      // Joins rather than per-row reads: this is the N+1 the list would otherwise be.
      .innerJoin(invProductVariants, eq(invProjectRequirements.productVariantId, invProductVariants.id))
      .innerJoin(invProducts, eq(invProductVariants.productId, invProducts.id))
      .leftJoin(invWarehouses, eq(invProjectRequirements.warehouseId, invWarehouses.id))
      .where(and(eq(invProjectRequirements.orgId, orgId), eq(invProjectRequirements.projectId, projectId)))
      .orderBy(asc(invProjectRequirements.requiredBy), asc(invProjectRequirements.id));
  }

  /**
   * B1 — what each line still needs, and whether it is heading for a miss.
   *
   * Two aggregate queries for the whole set rather than two per line. Reserved
   * comes from `inv_stock_reservations` and not from a column on the requirement,
   * because a stored copy can disagree with the reservations that actually exist
   * — and the moment it does, availability is wrong for everybody.
   */
  async coverageFor(
    orgId: string,
    rows: { id: number; productVariantId: number; warehouseId: number | null; requiredQty: string; fulfilledQty: string; requiredBy: string | null; leadTimeDays?: number | null }[],
  ): Promise<RequirementCoverage[]> {
    if (rows.length === 0) return [];
    const requirementIds = rows.map((r) => r.id);
    const variantIds = [...new Set(rows.map((r) => r.productVariantId))];

    const [reservedRows, availableRows] = await Promise.all([
      this.db
        .select({
          sourceLineId: invStockReservations.sourceLineId,
          reserved: sql<string>`COALESCE(SUM(${invStockReservations.reservedQty}::numeric), 0)::text`,
        })
        .from(invStockReservations)
        .where(
          and(
            eq(invStockReservations.orgId, orgId),
            eq(invStockReservations.sourceType, PROJECT_REQUIREMENT_SOURCE),
            eq(invStockReservations.status, "ACTIVE"),
            inArray(invStockReservations.sourceLineId, requirementIds.map(String)),
          ),
        )
        .groupBy(invStockReservations.sourceLineId),
      this.db
        .select({
          productVariantId: invStockLevels.productVariantId,
          warehouseId: invLocations.warehouseId,
          available: sql<string>`${availableQtySumSql("inv_stock_levels")}::text`,
        })
        .from(invStockLevels)
        .innerJoin(invLocations, eq(invStockLevels.locationId, invLocations.id))
        .where(and(eq(invStockLevels.orgId, orgId), inArray(invStockLevels.productVariantId, variantIds)))
        .groupBy(invStockLevels.productVariantId, invLocations.warehouseId),
    ]);

    const reservedByLine = new Map(reservedRows.map((r) => [r.sourceLineId ?? "", r.reserved]));
    const availByVariantWarehouse = new Map<string, string>();
    const availByVariant = new Map<string, string>();
    for (const row of availableRows) {
      availByVariantWarehouse.set(`${row.productVariantId}:${row.warehouseId}`, row.available);
      availByVariant.set(
        String(row.productVariantId),
        addDec(availByVariant.get(String(row.productVariantId)) ?? "0", row.available),
      );
    }

    const today = new Date();
    return rows.map((row) => {
      const reserved = reservedByLine.get(String(row.id)) ?? "0";
      const available =
        row.warehouseId != null
          ? availByVariantWarehouse.get(`${row.productVariantId}:${row.warehouseId}`) ?? "0"
          : availByVariant.get(String(row.productVariantId)) ?? "0";
      // The rule itself lives in `lib/coverage.ts`, pure and clock-injected, so
      // every combination of held/available/date is testable without a database.
      const assessment = assessCoverage(
        {
          requiredQty: row.requiredQty,
          reservedQty: reserved,
          fulfilledQty: row.fulfilledQty,
          availableQty: available,
          requiredBy: row.requiredBy,
          leadTimeDays: row.leadTimeDays ?? null,
        },
        today,
      );

      return {
        requirementId: row.id,
        requiredQty: row.requiredQty,
        reservedQty: reserved,
        fulfilledQty: row.fulfilledQty,
        shortfallQty: assessment.shortfallQty,
        availableQty: available,
        atRisk: assessment.atRisk,
        riskReason: assessment.riskReason,
      };
    });
  }

  async createProject(orgId: string, userId: string, data: CreateProjectInput) {
    await this.assertPack(orgId);
    try {
      const [row] = await this.db
        .insert(invProjects)
        .values({ orgId, createdBy: userId, ...data })
        .returning();
      await this.audit.insert(this.db, {
        orgId,
        actorUserId: userId,
        action: "project.created",
        resourceType: "inv_project",
        resourceId: String(row!.id),
        after: row,
      });
      await this.cache.invalidateNamespaceForOrg(orgId, "inv:projects");
      return row!;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(`A project with code ${data.code} already exists`);
      }
      throw err;
    }
  }

  async updateProject(orgId: string, userId: string, projectId: number, data: UpdateProjectInput) {
    await this.assertPack(orgId);
    const before = await this.db.query.invProjects.findFirst({
      where: and(eq(invProjects.id, projectId), eq(invProjects.orgId, orgId), isNull(invProjects.deletedAt)),
    });
    if (!before) throw new NotFoundException("Project not found");
    if (Object.keys(data).length === 0) return before;

    // A cross-field rule the PATCH shape cannot see on its own: a request that
    // moves only the end date has to be checked against the start already stored.
    const startsOn = data.startsOn !== undefined ? data.startsOn : before.startsOn;
    const endsOn = data.endsOn !== undefined ? data.endsOn : before.endsOn;
    if (startsOn && endsOn && startsOn > endsOn) {
      throw new BadRequestException("A project cannot end before it starts");
    }

    try {
      const [row] = await this.db
        .update(invProjects)
        .set({ ...data, updatedAt: new Date() })
        .where(and(eq(invProjects.id, projectId), eq(invProjects.orgId, orgId)))
        .returning();
      await this.audit.insert(this.db, {
        orgId,
        actorUserId: userId,
        action: "project.updated",
        resourceType: "inv_project",
        resourceId: String(projectId),
        before,
        after: row,
      });
      await this.cache.invalidateNamespaceForOrg(orgId, "inv:projects");
      return row!;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException("A project with that code already exists");
      }
      throw err;
    }
  }

  /**
   * Soft delete, per §3 — and refused while stock is still held for the site.
   *
   * Archiving a project whose lines hold reservations would leave those holds
   * standing with nothing on screen pointing at them: stock nobody can sell and
   * nobody can find. Release them first, deliberately.
   */
  async archiveProject(orgId: string, userId: string, projectId: number) {
    await this.assertPack(orgId);
    const before = await this.db.query.invProjects.findFirst({
      where: and(eq(invProjects.id, projectId), eq(invProjects.orgId, orgId), isNull(invProjects.deletedAt)),
    });
    if (!before) throw new NotFoundException("Project not found");

    const [held] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(invStockReservations)
      .innerJoin(
        invProjectRequirements,
        and(
          eq(invProjectRequirements.orgId, invStockReservations.orgId),
          sql`${invStockReservations.sourceLineId} = ${invProjectRequirements.id}::text`,
        ),
      )
      .where(
        and(
          eq(invStockReservations.orgId, orgId),
          eq(invStockReservations.sourceType, PROJECT_REQUIREMENT_SOURCE),
          eq(invStockReservations.status, "ACTIVE"),
          eq(invProjectRequirements.projectId, projectId),
        ),
      );
    if ((held?.count ?? 0) > 0) {
      throw new ConflictException({
        code: "PROJECT_HAS_ACTIVE_RESERVATIONS",
        message: `This project still holds ${held?.count} active stock reservation(s). Release them before archiving, or the stock stays held with nothing pointing at it.`,
      });
    }

    const [row] = await this.db
      .update(invProjects)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(invProjects.id, projectId), eq(invProjects.orgId, orgId)))
      .returning({ id: invProjects.id, code: invProjects.code, deletedAt: invProjects.deletedAt });
    await this.audit.insert(this.db, {
      orgId,
      actorUserId: userId,
      action: "project.archived",
      resourceType: "inv_project",
      resourceId: String(projectId),
      before,
      after: row,
    });
    await this.cache.invalidateNamespaceForOrg(orgId, "inv:projects");
    return row!;
  }

  async addRequirement(orgId: string, userId: string, projectId: number, data: CreateRequirementInput) {
    await this.assertPack(orgId);
    const project = await this.db.query.invProjects.findFirst({
      where: and(eq(invProjects.id, projectId), eq(invProjects.orgId, orgId), isNull(invProjects.deletedAt)),
      columns: { id: true, status: true },
    });
    if (!project) throw new NotFoundException("Project not found");
    if (project.status === "COMPLETED" || project.status === "CANCELLED") {
      throw new BadRequestException(`Cannot add material to a ${project.status.toLowerCase()} project`);
    }

    // BOLA, §4: the variant is a resource id the caller supplied, so its tenancy
    // is re-asserted here rather than trusted from the composite FK's error.
    const variant = await this.db.query.invProductVariants.findFirst({
      where: and(
        eq(invProductVariants.id, data.productVariantId),
        eq(invProductVariants.orgId, orgId),
        isNull(invProductVariants.deletedAt),
      ),
      columns: { id: true },
    });
    if (!variant) throw new NotFoundException("Product variant not found");

    if (data.warehouseId != null) {
      const wh = await this.db.query.invWarehouses.findFirst({
        where: and(eq(invWarehouses.id, data.warehouseId), eq(invWarehouses.orgId, orgId)),
        columns: { id: true },
      });
      if (!wh) throw new NotFoundException("Dark store not found");
    }

    const [row] = await this.db
      .insert(invProjectRequirements)
      .values({
        orgId,
        projectId,
        createdBy: userId,
        productVariantId: data.productVariantId,
        warehouseId: data.warehouseId ?? null,
        requiredQty: data.requiredQty,
        requiredBy: data.requiredBy ?? null,
        notes: data.notes ?? null,
        status: "REQUESTED",
      })
      .returning();
    await this.audit.insert(this.db, {
      orgId,
      actorUserId: userId,
      action: "project.requirement.created",
      resourceType: "inv_project_requirement",
      resourceId: String(row!.id),
      after: row,
      metadata: { projectId },
    });
    await this.cache.invalidateNamespaceForOrg(orgId, "inv:projects");
    return row!;
  }

  async updateRequirement(
    orgId: string,
    userId: string,
    projectId: number,
    requirementId: number,
    data: UpdateRequirementInput,
  ) {
    await this.assertPack(orgId);
    const before = await this.requirementOr404(orgId, projectId, requirementId);
    if (Object.keys(data).length === 0) return before;

    // Cutting a line below what is already reserved or dispatched would make the
    // reservation larger than the requirement it exists for — the shortfall goes
    // negative and the coverage figures stop meaning anything.
    if (data.requiredQty !== undefined) {
      const [coverage] = await this.coverageFor(orgId, [{ ...before, leadTimeDays: null }]);
      const committed = addDec(coverage?.reservedQty ?? "0", before.fulfilledQty);
      if (cmpDec(data.requiredQty, committed) < 0) {
        throw new BadRequestException({
          code: "REQUIREMENT_BELOW_COMMITTED",
          message: `${committed} is already reserved or delivered against this line, so it cannot be reduced to ${data.requiredQty}. Release the reservation first.`,
        });
      }
    }

    const [row] = await this.db
      .update(invProjectRequirements)
      .set({ ...data, updatedAt: new Date() })
      .where(
        and(
          eq(invProjectRequirements.id, requirementId),
          eq(invProjectRequirements.orgId, orgId),
          eq(invProjectRequirements.projectId, projectId),
        ),
      )
      .returning();
    await this.audit.insert(this.db, {
      orgId,
      actorUserId: userId,
      action: "project.requirement.updated",
      resourceType: "inv_project_requirement",
      resourceId: String(requirementId),
      before,
      after: row,
      metadata: { projectId },
    });
    await this.cache.invalidateNamespaceForOrg(orgId, "inv:projects");
    return row!;
  }

  private async requirementOr404(orgId: string, projectId: number, requirementId: number) {
    const row = await this.db.query.invProjectRequirements.findFirst({
      where: and(
        eq(invProjectRequirements.id, requirementId),
        eq(invProjectRequirements.orgId, orgId),
        eq(invProjectRequirements.projectId, projectId),
      ),
    });
    if (!row) throw new NotFoundException("Requirement not found");
    return row;
  }

  /**
   * The one gate in this file, and the only thing here that is not org-wide.
   *
   * Asked of the bin the stock **actually stands in**, never of the requirement's
   * `warehouse_id`. That column is an expectation ("which store the site expects
   * to be served from") and `updateRequirementSchema` lets anyone PATCH it, so a
   * gate reading it would answer for a building the hold is not in — and a hold
   * re-homed on paper would gate against the new store while the units stayed at
   * the old one. `inv_stock_reservations.location_id` is where the `committed`
   * quantity was actually written, and it is the only honest question to ask.
   *
   * Both callers ask it before touching anything: `reserveRequirement` because a
   * top-up **replaces** the standing hold, and `releaseRequirement` because
   * releasing hands another building's units back to whoever wants them next.
   * Neither reaches `StockEngineService.executeInTx`, so `assertLocationsInScope`
   * never runs on this path — `releaseReservationInTx` writes
   * `inv_stock_levels.committed` directly and says in its own docblock that the
   * gate belongs at the client-named entry point. This is that entry point.
   *
   * Every hold is asserted before any is touched, so a scoped caller cannot get a
   * partial release. `uniq_inv_reservations_org_source_active` allows one active
   * hold per line, so this loop is one iteration in practice; it is a loop because
   * the release path is one, and a gate that covered only the first row would be
   * a gate that agreed with the code by coincidence.
   *
   * 404, never 403: a "forbidden" on a requirement whose hold sits in another
   * building confirms both the hold and the building exist, which turns a probe
   * into an existence oracle (§4). `assertLocationVisible` already answers that
   * way, and an unattributed hold (`location_id IS NULL`) is attributable to none
   * of the caller's warehouses, so it is refused too — `NULL IN (…)` is NULL, the
   * same rule the rest of the module reads by.
   */
  /**
   * B1 — hold stock for one requirement.
   *
   * The hold itself is `ReservationService`: the engine is the only thing that
   * may increment `committed`, and a second path that touched it would be a
   * second answer to how much is available. This method decides *how much* and
   * *where from*, and hands the rest over.
   *
   * Reserving again on a line that already holds stock **replaces** the hold with
   * a larger one, in one transaction, rather than refusing. One active hold per
   * line is a database constraint, not a product decision, and "Reserve Stock"
   * pressed twice should hold more — not fail with a uniqueness error the
   * operator cannot act on.
   */
  async reserveRequirement(
    orgId: string,
    userId: string,
    projectId: number,
    requirementId: number,
    input: ReserveRequirementInput,
  ) {
    await this.assertPack(orgId);
    const requirement = await this.requirementOr404(orgId, projectId, requirementId);
    if (requirement.status === "CANCELLED") {
      throw new BadRequestException("This requirement is cancelled — reinstate it before reserving stock");
    }

    const [coverage] = await this.coverageFor(orgId, [{ ...requirement, leadTimeDays: null }]);
    const alreadyHeld = coverage?.reservedQty ?? "0";
    const outstanding = coverage?.shortfallQty ?? "0";
    if (cmpDec(outstanding, "0") <= 0) {
      throw new BadRequestException({
        code: "REQUIREMENT_FULLY_COVERED",
        message: "This line is already fully reserved or delivered — there is nothing left to hold.",
      });
    }
    const qty = input.qty ?? outstanding;
    if (cmpDec(qty, outstanding) > 0) {
      throw new BadRequestException({
        code: "RESERVATION_EXCEEDS_REQUIREMENT",
        message: `Only ${outstanding} is still outstanding on this line — reserving ${qty} would hold stock nothing has asked for.`,
      });
    }

    const warehouseId = input.warehouseId ?? requirement.warehouseId ?? undefined;
    if (warehouseId != null) {
      await this.warehouseScope.assertWarehouseVisible(orgId, userId, warehouseId);
    }

    // The hold that replaces an existing one has to cover both, so the location
    // is resolved against the total rather than against the increment.
    const totalQty = addDec(alreadyHeld, qty);

    const scope = await this.warehouseScope.resolve(orgId, userId);

    let locationId = input.locationId;
    if (locationId != null) {
      const owned = await this.db.query.invLocations.findFirst({
        where: and(eq(invLocations.id, locationId), eq(invLocations.orgId, orgId)),
        columns: { id: true },
      });
      if (!owned) throw new NotFoundException("Storage location not found");
      // Owning the bin is tenancy; being shown it is scope. `warehouseId` is
      // optional on this payload, so a caller naming a bare `locationId` skipped
      // the assert above entirely and could take a hold anywhere in the org.
      await this.warehouseScope.assertLocationVisible(orgId, userId, locationId);
    } else {
      const resolved = await resolveReservationLocation(
        this.db,
        this.warehouseScope,
        orgId,
        requirement.productVariantId,
        warehouseId,
        totalQty,
        await heldByLocation(this.db, orgId, requirementId),
        scope,
      );
      if (resolved.locationId === null) {
        throw new BadRequestException({
          code: "NO_SINGLE_LOCATION_COVERS_QTY",
          message:
            `No single pickable bin${warehouseId != null ? " at this dark store" : ""} holds ${totalQty} available — the largest has ${resolved.best}. ` +
            "Transfer stock in, split the requirement, or reserve from a named bin.",
        });
      }
      locationId = resolved.locationId;
    }

    const existing = await this.db
      .select({ id: invStockReservations.id, locationId: invStockReservations.locationId })
      .from(invStockReservations)
      .where(
        and(
          eq(invStockReservations.orgId, orgId),
          eq(invStockReservations.sourceType, PROJECT_REQUIREMENT_SOURCE),
          eq(invStockReservations.sourceLineId, String(requirementId)),
          eq(invStockReservations.status, "ACTIVE"),
        ),
      );
    // A top-up releases what is standing before it re-takes the total, so the
    // caller has to be allowed to touch the OLD bin as well as the new one.
    await assertHoldsInScope(this.warehouseScope, orgId, userId, existing);

    const reservation = await this.db.transaction(async (tx) => {
      // Replace rather than add: the unique index allows one active hold per
      // line, and releasing inside the same transaction means `committed` is
      // never briefly wrong and never doubly held.
      for (const row of existing) {
        await this.reservations.releaseReservationInTx(tx, orgId, userId, row.id);
      }
      const created = await this.reservations.createReservationInTx(tx, orgId, userId, {
        sourceType: PROJECT_REQUIREMENT_SOURCE,
        sourceId: String(projectId),
        sourceLineId: String(requirementId),
        productVariantId: requirement.productVariantId,
        warehouseId,
        locationId,
        qty: totalQty,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : undefined,
      });
      // The line's own status follows the hold, in the same transaction: a
      // requirement that reads REQUESTED while stock is held for it is a lie the
      // planner acts on.
      const nextStatus = cmpDec(totalQty, addDec(alreadyHeld, outstanding)) >= 0 ? "RESERVED" : "PARTIALLY_FULFILLED";
      await tx
        .update(invProjectRequirements)
        .set({ status: nextStatus, updatedAt: new Date() })
        .where(and(eq(invProjectRequirements.id, requirementId), eq(invProjectRequirements.orgId, orgId)));
      await this.audit.insert(tx, {
        orgId,
        actorUserId: userId,
        action: "project.requirement.reserved",
        resourceType: "inv_project_requirement",
        resourceId: String(requirementId),
        metadata: {
          projectId, addedQty: qty, totalQty, reservationId: created.id,
          warehouseId: warehouseId ?? null, locationId,
          replacedReservationIds: existing.map((r) => r.id),
        },
      });
      return created;
    });

    await this.cache.invalidateNamespaceForOrg(orgId, "inv:projects");
    return reservation;
  }

  /**
   * Releases every active hold on a requirement and puts the line back to REQUESTED.
   *
   * Gated on the bin each hold stands in, which is the half `reserveRequirement`
   * had and this did not. Releasing is not the harmless end of reserving: it
   * hands the units back to whoever asks next, and this path never reaches
   * `StockEngineService.executeInTx`, so nothing downstream was going to catch
   * it. A picker assigned to one building could take any project requirement id
   * in the organisation and drop another building's hold — and because the
   * project surface is org-wide by design (see the class docblock), every id they
   * needed was already on the screen in front of them.
   */
  async releaseRequirement(orgId: string, userId: string, projectId: number, requirementId: number) {
    await this.assertPack(orgId);
    await this.requirementOr404(orgId, projectId, requirementId);

    const active = await this.db
      .select({ id: invStockReservations.id, locationId: invStockReservations.locationId })
      .from(invStockReservations)
      .where(
        and(
          eq(invStockReservations.orgId, orgId),
          eq(invStockReservations.sourceType, PROJECT_REQUIREMENT_SOURCE),
          eq(invStockReservations.sourceLineId, String(requirementId)),
          eq(invStockReservations.status, "ACTIVE"),
        ),
      );
    if (active.length === 0) {
      throw new BadRequestException({
        code: "NO_ACTIVE_RESERVATION",
        message: "Nothing is currently held for this line.",
      });
    }
    // The 400 above and the 404 below do tell an out-of-scope caller whether a
    // hold exists on this line, and that is not a leak here: `getProject`
    // already reports `coverage.reservedQty` on every line to every reader,
    // because the planning surface is org-wide by design. What the gate protects
    // is the ACT, not the fact — the units, and who may hand them back.
    await assertHoldsInScope(this.warehouseScope, orgId, userId, active);

    const released = await this.db.transaction(async (tx) => {
      let count = 0;
      for (const row of active) {
        const result = await this.reservations.releaseReservationInTx(tx, orgId, userId, row.id);
        if (result) count += 1;
      }
      await tx
        .update(invProjectRequirements)
        .set({ status: "REQUESTED", updatedAt: new Date() })
        .where(and(eq(invProjectRequirements.id, requirementId), eq(invProjectRequirements.orgId, orgId)));
      await this.audit.insert(tx, {
        orgId,
        actorUserId: userId,
        action: "project.requirement.released",
        resourceType: "inv_project_requirement",
        resourceId: String(requirementId),
        metadata: { projectId, releasedCount: count },
      });
      return count;
    });

    await this.cache.invalidateNamespaceForOrg(orgId, "inv:projects");
    return { released };
  }

  /**
   * B1 — the at-risk feed: open requirements that are not going to be met.
   *
   * Used by the operations dashboard and by the projects screen, so the rule
   * lives here once. Bounded: a feed that can return an organisation's whole
   * backlog is a page that never loads.
   */
  async atRiskRequirements(orgId: string, limit = 25) {
    await this.assertPack(orgId);
    const rows = await this.db
      .select({
        id: invProjectRequirements.id,
        projectId: invProjectRequirements.projectId,
        productVariantId: invProjectRequirements.productVariantId,
        warehouseId: invProjectRequirements.warehouseId,
        requiredQty: invProjectRequirements.requiredQty,
        fulfilledQty: invProjectRequirements.fulfilledQty,
        requiredBy: invProjectRequirements.requiredBy,
        status: invProjectRequirements.status,
        leadTimeDays: invProducts.leadTimeDays,
        projectCode: invProjects.code,
        projectName: invProjects.name,
        projectZone: invProjects.zone,
        productName: invProducts.name,
        variantSku: invProductVariants.sku,
      })
      .from(invProjectRequirements)
      .innerJoin(
        invProjects,
        and(eq(invProjectRequirements.projectId, invProjects.id), eq(invProjects.orgId, invProjectRequirements.orgId)),
      )
      .innerJoin(invProductVariants, eq(invProjectRequirements.productVariantId, invProductVariants.id))
      .innerJoin(invProducts, eq(invProductVariants.productId, invProducts.id))
      .where(
        and(
          eq(invProjectRequirements.orgId, orgId),
          isNull(invProjects.deletedAt),
          inArray(invProjects.status, [...OPEN_PROJECT_STATUSES]),
          inArray(invProjectRequirements.status, [...OPEN_REQUIREMENT_STATUSES]),
        ),
      )
      // Nulls last: a line with no date is real work, but a dated one is the one
      // somebody is waiting on.
      .orderBy(sql`${invProjectRequirements.requiredBy} ASC NULLS LAST`, asc(invProjectRequirements.id))
      // Over-read deliberately: coverage is what decides "at risk", and it cannot
      // be expressed as a WHERE without duplicating the availability expression.
      .limit(limit * 8);

    const coverage = await this.coverageFor(orgId, rows);
    const byId = new Map(coverage.map((c) => [c.requirementId, c]));
    return rows
      .map((r) => ({ ...r, coverage: byId.get(r.id)! }))
      .filter((r) => r.coverage?.atRisk)
      .slice(0, limit);
  }
}


