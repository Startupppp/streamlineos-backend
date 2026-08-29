import { Inject, Injectable } from "@nestjs/common";
import { sql, type SQL } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type {
  ValuationSummaryInput,
  ValuationLayersInput,
  ValuationConsumptionsInput,
} from "./dto/valuation.schemas";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { InventoryPeriodService, todayIso, type InventoryPeriod } from "./inventory-period.service";
import {
  asAtValuationSql,
  consumptionEvidenceSql,
  layerEvidenceSql,
  liveValuationSql,
} from "./lib/valuation-sql";

/**
 * Every quantity and every money figure below leaves Postgres as `text` and is
 * never parsed. `parseFloat` on a `numeric(18,4)` is lossy in both directions —
 * it loses precision on the way in and invents digits on the way out — and this
 * service is where an organisation's stock value is quoted from.
 */
export interface ValuationSummaryRow {
  productVariantId: number;
  variantSku: string;
  variantName: string | null;
  productId: number;
  productName: string;
  costingMethod: string;
  onHand: string;
  value: string;
  fifoValue: string;
  standardCost: string;
  unitCostBasis: string;
  layerCount: number;
}

export interface ValuationGrain {
  asOfDate: string;
  /** True when the figure is today's projection rather than a ledger replay. */
  live: boolean;
  period: InventoryPeriod | null;
}

interface SummaryRow extends ValuationSummaryRow, Record<string, unknown> {
  totalRows: number;
  totalValue: string;
  totalOnHand: string;
}

interface LayerRow extends Record<string, unknown> {
  layerId: number;
  createdAt: Date;
  stockTransactionId: number | null;
  costingMethod: string;
  sourceType: string | null;
  sourceId: string | null;
  locationId: number | null;
  locationName: string | null;
  warehouseName: string | null;
  lotId: number | null;
  lotNumber: string | null;
  quantity: string;
  unitCost: string;
  totalValue: string;
  remainingQuantity: string;
  remainingValue: string;
  consumedQuantity: string;
  consumptionCount: number;
  remainingQuantityAsAt: string;
  remainingValueAsAt: string;
  totalRows: number;
}

interface ConsumptionRow extends Record<string, unknown> {
  consumptionId: number;
  createdAt: Date;
  stockTransactionId: number;
  valuationLayerId: number;
  quantity: string;
  unitCost: string;
  totalCost: string;
  layerUnitCost: string;
  layerCreatedAt: Date;
  layerSourceType: string | null;
  layerSourceId: string | null;
  costingMethod: string;
  productVariantId: number;
  transactionType: string;
  referenceType: string | null;
  referenceId: string | null;
  postingDate: string;
  variantSku: string;
  productName: string;
  locationName: string | null;
  totalRows: number;
}

@Injectable()
export class InvValuationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly warehouseScope: WarehouseScopeService,
    private readonly periods: InventoryPeriodService,
  ) {}

  private async locationScope(orgId: string, userId: string): Promise<(column: string) => SQL> {
    const scope = await this.warehouseScope.resolve(orgId, userId);
    return (column: string) => this.warehouseScope.locationPredicate(scope, column);
  }

  async getValuationSummary(orgId: string, userId: string, filters: ValuationSummaryInput) {
    const { warehouseId, categoryId, page, limit } = filters;
    const grain = await this.periods.resolveAsAt(orgId, filters);
    const live = grain.asOfDate >= todayIso();
    const locationScope = await this.locationScope(orgId, userId);

    const params = {
      orgId,
      locationScope,
      warehouseId,
      categoryId,
      asOfDate: grain.asOfDate,
      limit,
      offset: (page - 1) * limit,
    };
    const rows = await this.db.execute<SummaryRow>(
      live ? liveValuationSql(params) : asAtValuationSql(params),
    );

    const first = rows[0];
    const total = first?.totalRows ?? 0;
    return {
      grain: { asOfDate: grain.asOfDate, live, period: grain.period },
      items: rows.map(({ totalRows: _t, totalValue: _v, totalOnHand: _o, ...row }) => row),
      totalValue: first?.totalValue ?? "0",
      totalOnHand: first?.totalOnHand ?? "0",
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * The layers standing behind one variant's value, each with the quantity and
   * value it still held on the quoted date and how much had been drawn out of it
   * by then. A valuation figure that cannot be opened is an assertion; this is
   * what makes it a derivation.
   */
  async getValuationLayers(orgId: string, userId: string, filters: ValuationLayersInput) {
    const { variantId, warehouseId, page, limit } = filters;
    const grain = await this.periods.resolveAsAt(orgId, filters);
    const locationScope = await this.locationScope(orgId, userId);

    const rows = await this.db.execute<LayerRow>(
      layerEvidenceSql(
        orgId,
        variantId,
        locationScope,
        grain.asOfDate,
        warehouseId,
        limit,
        (page - 1) * limit,
      ),
    );

    const total = rows[0]?.totalRows ?? 0;
    return {
      grain: { asOfDate: grain.asOfDate, live: grain.asOfDate >= todayIso(), period: grain.period },
      items: rows.map(({ totalRows: _t, ...row }) => row),
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Consumption lines. `commitIssue` writes one per layer an issue draws from,
   * carrying the quantity taken and the unit cost it was taken at, so cost of
   * goods sold is reproducible from rows rather than recomputed from a
   * `remaining_quantity` that has since moved on.
   */
  async getValuationConsumptions(
    orgId: string,
    userId: string,
    filters: ValuationConsumptionsInput,
  ) {
    const { variantId, layerId, stockTransactionId, page, limit } = filters;
    const window = await this.periods.resolveWindow(orgId, {
      periodId: filters.periodId,
      fromDate: filters.fromDate,
      toDate: filters.toDate,
    });
    const locationScope = await this.locationScope(orgId, userId);

    const conditions: SQL[] = [
      sql`vc.created_at::date >= ${window.fromDate}::date`,
      sql`vc.created_at::date <= ${window.toDate}::date`,
    ];
    if (variantId != null) conditions.push(sql`t.product_variant_id = ${variantId}`);
    if (layerId != null) conditions.push(sql`vc.valuation_layer_id = ${layerId}`);
    if (stockTransactionId != null)
      conditions.push(sql`vc.stock_transaction_id = ${stockTransactionId}`);

    const rows = await this.db.execute<ConsumptionRow>(
      consumptionEvidenceSql(
        orgId,
        sql.join(conditions, sql` AND `),
        locationScope,
        limit,
        (page - 1) * limit,
      ),
    );

    const total = rows[0]?.totalRows ?? 0;
    return {
      window: { fromDate: window.fromDate, toDate: window.toDate, period: window.period },
      items: rows.map(({ totalRows: _t, ...row }) => row),
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  listPeriods(orgId: string) {
    return this.periods.listPeriods(orgId);
  }
}
