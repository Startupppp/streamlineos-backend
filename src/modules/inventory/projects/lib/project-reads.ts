import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { NotFoundException } from "@nestjs/common";
import {
  invProjectRequirements,
  invProjects,
  invStockReservations,
} from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.module";

import {
  invLocations,
  invProductVariants,
  invProducts,
  invStockLevels,
  invWarehouses,
} from "../../../../db/schema";
import { availableQtySumSql } from "../../stock-engine/available-sql";
import { addDec } from "../../stock-engine/decimal";
import { assessCoverage, type RequirementCoverage } from "./coverage";
import {
  OPEN_PROJECT_STATUSES,
  OPEN_REQUIREMENT_STATUSES,
  PROJECT_REQUIREMENT_SOURCE,
} from "../inv-projects.constants";
import type { InventorySettingsService } from "../../stock-engine/inventory-settings.service";

/**
 * Reading a construction project: the materials-pack gate every surface passes,
 * the requirement rows, what covers them, and which are at risk. Lifted out of
 * `inv-projects.service.ts` unchanged.
 *
 * `assertPack` moved with them because the reads gate on it and it needs nothing
 * but the settings service. `coverageFor` and `atRiskRequirements` are public
 * API and keep delegates on the service.
 */
  /**
   * B1 — every project surface is behind the `materials` pack.
   *
   * A 404 rather than a 403: with the pack off this module is not part of the
   * product the organisation is running, and "you may not see this" would imply
   * there is something to see. Same reasoning the quick-commerce ingest uses.
   */
export async function assertPack(
    settingsService: InventorySettingsService,
orgId: string): Promise<void> {
    const settings = await settingsService.get(orgId);
    if (!settings.packs.materials) {
      throw new NotFoundException({
        code: "MATERIALS_PACK_DISABLED",
        message: "Construction projects are part of the materials pack, which is not enabled for this organisation.",
      });
    }
  }

export async function listRequirementRows(
    db: Db,
orgId: string, projectId: number) {
    return db
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
export async function coverageFor(
    db: Db,

    orgId: string,
    rows: { id: number; productVariantId: number; warehouseId: number | null; requiredQty: string; fulfilledQty: string; requiredBy: string | null; leadTimeDays?: number | null }[],
  ): Promise<RequirementCoverage[]> {
    if (rows.length === 0) return [];
    const requirementIds = rows.map((r) => r.id);
    const variantIds = [...new Set(rows.map((r) => r.productVariantId))];

    const [reservedRows, availableRows] = await Promise.all([
      db
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
      db
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

export async function requirementOr404(
    db: Db,
orgId: string, projectId: number, requirementId: number) {
    const row = await db.query.invProjectRequirements.findFirst({
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
   * B1 — the at-risk feed: open requirements that are not going to be met.
   *
   * Used by the operations dashboard and by the projects screen, so the rule
   * lives here once. Bounded: a feed that can return an organisation's whole
   * backlog is a page that never loads.
   */
export async function atRiskRequirements(
    db: Db,
    settingsService: InventorySettingsService,
orgId: string, limit = 25) {
    await assertPack(settingsService, orgId);
    const rows = await db
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

    const coverage = await coverageFor(db, orgId, rows);
    const byId = new Map(coverage.map((c) => [c.requirementId, c]));
    return rows
      .map((r) => ({ ...r, coverage: byId.get(r.id)! }))
      .filter((r) => r.coverage?.atRisk)
      .slice(0, limit);
  }
