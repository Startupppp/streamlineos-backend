import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { Db } from "../../db/drizzle.types";
import { cellCapacityMeasurements, placementDecisions } from "../../db/schema";
import { logger } from "../logger/logger.service";
import type { CellUtilisation } from "../placement/cell-capacity";
import {
  selectCell,
  type CellCandidate,
  type CellRejection,
  type TenantClass,
} from "../placement/placement-selection";
import { runOutsideTenantContext } from "../tenant/tenant-context";
import {
  DEFAULT_REGION,
  getRegionRegistry,
  hasRegionRegistry,
} from "./region-registry";
import { LEGACY_CELL_ID } from "./placement";

export const MEASUREMENT_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
export const MEASUREMENT_STALE_AFTER_DAYS = MEASUREMENT_STALE_AFTER_MS / 86_400_000;

export interface NewOrgPlacementRequest {
  readonly organizationId: string;
  readonly region?: string;
  readonly complianceRequirements?: readonly string[];
  readonly tenantClass?: TenantClass;
  readonly dedicatedCellId?: string;
}

export type RegionChoice =
  | {
      readonly kind: "selected";
      readonly region: string;
      readonly cellId: string;
      readonly rejections: readonly CellRejection[];
    }
  | {
      readonly kind: "unmeasured-fallback";
      readonly region: string;
      readonly reason: string;
    };

export interface RegionPlacementCoordinates {
  region: string;
  cellId: string;
}

export function regionPlacementCoordinates(
  choice: RegionChoice,
): RegionPlacementCoordinates {
  if (choice.kind === "selected")
    return { region: choice.region, cellId: choice.cellId };
  if (hasRegionRegistry())
    return {
      region: choice.region,
      cellId: getRegionRegistry().cellFor(choice.region),
    };
  return { region: choice.region, cellId: LEGACY_CELL_ID };
}

export class CellAdmissionRefusedError extends Error {
  constructor(
    readonly organizationId: string,
    readonly rejections: readonly CellRejection[],
  ) {
    super(
      `No cell can admit organisation ${organizationId}. ` +
        rejections.map((r) => `${r.cellId}=${r.code}`).join(", "),
    );
    this.name = "CellAdmissionRefusedError";
  }
}

interface MeasuredCell {
  readonly utilisation: CellUtilisation;
  readonly perOrgCost: number;
}

export interface AdmissionDeps {
  readonly measurementFor: (cellId: string) => Promise<MeasuredCell | null>;
  readonly cells: readonly {
    readonly region: string;
    readonly cellId: string;
    readonly acceptedTenantClasses: readonly TenantClass[];
    readonly complianceZones: readonly string[];
  }[];
  readonly recordDecision: (decision: {
    organizationId: string;
    region: string;
    tenantClass: TenantClass;
    admitted: boolean;
    selectedCellId: string | null;
    rejections: readonly CellRejection[];
  }) => Promise<void>;
}

export async function decideRegion(
  deps: AdmissionDeps,
  request: NewOrgPlacementRequest,
  fallbackRegion: string,
): Promise<RegionChoice> {
  const region = request.region ?? fallbackRegion;
  const tenantClass: TenantClass = request.tenantClass ?? "SHARED";

  const pool: CellCandidate[] = [];
  let perOrgCost = 1;

  for (const cell of deps.cells) {
    const measured = await deps.measurementFor(cell.cellId);
    if (!measured) continue;
    perOrgCost = measured.perOrgCost;
    pool.push({
      cellId: cell.cellId,
      region: cell.region,
      complianceZones: cell.complianceZones,
      utilisation: measured.utilisation,
      acceptedTenantClasses: cell.acceptedTenantClasses,
    });
  }

  if (pool.length === 0) {
    const reason =
      `no cell has a capacity measurement within ${MEASUREMENT_STALE_AFTER_DAYS} days; ` +
      "run pnpm -C backend cell:capacity";
    await deps.recordDecision({
      organizationId: request.organizationId,
      region,
      tenantClass,
      admitted: true,
      selectedCellId: null,
      rejections: [],
    });
    return { kind: "unmeasured-fallback", region, reason };
  }

  const result = selectCell(pool, {
    organizationId: request.organizationId,
    region,
    complianceRequirements: request.complianceRequirements ?? [],
    tenantClass,
    dedicatedPin: request.dedicatedCellId ? { cellId: request.dedicatedCellId } : undefined,
    perOrgCost,
  });

  await deps.recordDecision({
    organizationId: request.organizationId,
    region,
    tenantClass,
    admitted: result.admitted,
    selectedCellId: result.admitted ? result.cellId : null,
    rejections: result.rejections,
  });

  if (!result.admitted)
    throw new CellAdmissionRefusedError(request.organizationId, result.rejections);

  const chosen = pool.find((candidate) => candidate.cellId === result.cellId);
  return {
    kind: "selected",
    region: chosen?.region ?? region,
    cellId: result.cellId,
    rejections: result.rejections,
  };
}

function liveDeps(db: Db, now: number): AdmissionDeps {
  const registry = hasRegionRegistry() ? getRegionRegistry() : null;

  return {
    cells: registry
      ? registry.keys.map((key) => {
          const cell = registry.bindingFor(key).definition.cell;
          return {
            region: key,
            cellId: cell.cellId,
            acceptedTenantClasses: cell.acceptedTenantClasses,
            complianceZones: cell.complianceZones,
          };
        })
      : [],

    measurementFor: async (cellId) => {
      const rows = await db
        .select({
          limitingResource: cellCapacityMeasurements.limitingResource,
          used: cellCapacityMeasurements.used,
          limitValue: cellCapacityMeasurements.limitValue,
          perOrgCost: cellCapacityMeasurements.perOrgCost,
          measuredAt: cellCapacityMeasurements.measuredAt,
        })
        .from(cellCapacityMeasurements)
        .where(eq(cellCapacityMeasurements.cellId, cellId))
        .orderBy(desc(cellCapacityMeasurements.measuredAt))
        .limit(1);

      const row = rows[0];
      if (!row) return null;

      const measuredAt = row.measuredAt.getTime();
      if (now - measuredAt > MEASUREMENT_STALE_AFTER_MS) return null;

      return {
        perOrgCost: row.perOrgCost,
        utilisation: {
          cellId,
          limitingResource: row.limitingResource,
          used: row.used,
          limit: row.limitValue,
          measuredAt,
        },
      };
    },

    recordDecision: async (decision) => {
      await db.insert(placementDecisions).values({
        id: randomUUID(),
        organizationId: decision.organizationId,
        region: decision.region,
        tenantClass: decision.tenantClass,
        admitted: decision.admitted,
        selectedCellId: decision.selectedCellId,
        rejections: decision.rejections.map((r) => ({ cellId: r.cellId, code: r.code })),
      });
    },
  };
}

export async function chooseRegionForNewOrg(
  db: Db,
  request: NewOrgPlacementRequest,
  now: number = Date.now(),
): Promise<RegionChoice> {
  const fallback = hasRegionRegistry() ? getRegionRegistry().primary : DEFAULT_REGION;

  return runOutsideTenantContext(async () => {
    const choice = await decideRegion(liveDeps(db, now), request, fallback);

    if (choice.kind === "unmeasured-fallback")
      logger.warn("[placement] placing on the primary without a capacity measurement", {
        orgId: request.organizationId,
        region: choice.region,
        reason: choice.reason,
      });

    return choice;
  });
}
