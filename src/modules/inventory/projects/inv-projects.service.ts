import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { isUniqueViolation } from "../../../common/db/postgres-error";
import {
  invProjects,
  invProjectRequirements,
  invProductVariants,
  invStockReservations,
  invWarehouses,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import { InventorySettingsService } from "../stock-engine/inventory-settings.service";
import { ReservationService } from "../stock-engine/reservation.service";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { addDec, cmpDec } from "../stock-engine/decimal";
import { PROJECT_REQUIREMENT_SOURCE } from "./inv-projects.constants";
export { PROJECT_REQUIREMENT_SOURCE } from "./inv-projects.constants";
import { type RiskReason } from "./lib/coverage";
import type {
  CreateProjectInput,
  CreateRequirementInput,
  ListProjectsInput,
  ReserveRequirementInput,
  UpdateProjectInput,
  UpdateRequirementInput,
} from "./dto/inv-projects.schemas";
import {
  assertPack,
  atRiskRequirements,
  coverageFor,
  listRequirementRows,
  requirementOr404,
} from "./lib/project-reads";
import { listProjects } from "./lib/project-list";
import {
  releaseRequirement,
  reserveRequirement,
  type ProjectDeps,
} from "./lib/project-reservation";



/** Statuses that mean the project is still consuming material. */
export const OPEN_PROJECT_STATUSES = ["PLANNING", "ACTIVE", "ON_HOLD"] as const;
/** Statuses that mean the line still wants stock. */
export const OPEN_REQUIREMENT_STATUSES = ["DRAFT", "REQUESTED", "RESERVED", "PARTIALLY_FULFILLED"] as const;


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


  /** @see lib/project-reads.ts */
  async listProjects(orgId: string, filters: ListProjectsInput) {
    return listProjects(this.db, this.settings, orgId, filters);
  }

  async getProject(orgId: string, projectId: number) {
    await assertPack(this.settings, orgId);
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

    const requirements = await listRequirementRows(this.db, orgId, projectId);
    const coverage = await coverageFor(this.db, orgId, requirements);
    const byId = new Map(coverage.map((c) => [c.requirementId, c]));

    return {
      ...project,
      requirements: requirements.map((r) => ({ ...r, coverage: byId.get(r.id) ?? null })),
    };
  }


  async createProject(orgId: string, userId: string, data: CreateProjectInput) {
    await assertPack(this.settings, orgId);
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
    await assertPack(this.settings, orgId);
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
    await assertPack(this.settings, orgId);
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
    await assertPack(this.settings, orgId);
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
    await assertPack(this.settings, orgId);
    const before = await requirementOr404(this.db, orgId, projectId, requirementId);
    if (Object.keys(data).length === 0) return before;

    // Cutting a line below what is already reserved or dispatched would make the
    // reservation larger than the requirement it exists for — the shortfall goes
    // negative and the coverage figures stop meaning anything.
    if (data.requiredQty !== undefined) {
      const [coverage] = await coverageFor(this.db, orgId, [{ ...before, leadTimeDays: null }]);
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


  /** @see lib/project-reads.ts — public, and a spec reaches it on the service. */
  async coverageFor(
    orgId: string,
    rows: { id: number; productVariantId: number; warehouseId: number | null; requiredQty: string; fulfilledQty: string; requiredBy: string | null; leadTimeDays?: number | null }[],
  ) {
    return coverageFor(this.db, orgId, rows);
  }

  /** The bag the reservation commands take; built explicitly because the constructor fields are private. */
  private get projectDeps(): ProjectDeps {
    return {
      db: this.db,
      cache: this.cache,
      audit: this.audit,
      settings: this.settings,
      reservations: this.reservations,
      warehouseScope: this.warehouseScope,
    };
  }

  /** @see lib/project-reservation.ts — the bodies moved, the route surface did not. */
  async reserveRequirement(
    orgId: string,
    userId: string,
    projectId: number,
    requirementId: number,
    input: ReserveRequirementInput,
  ) {
    return reserveRequirement(this.projectDeps, orgId, userId, projectId, requirementId, input);
  }

  /** @see lib/project-reservation.ts */
  async releaseRequirement(orgId: string, userId: string, projectId: number, requirementId: number) {
    return releaseRequirement(this.projectDeps, orgId, userId, projectId, requirementId);
  }

  /** @see lib/project-reads.ts */
  async atRiskRequirements(orgId: string, limit = 25) {
    return atRiskRequirements(this.db, this.settings, orgId, limit);
  }
}


