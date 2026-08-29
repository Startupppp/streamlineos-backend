import type { InvReportsService } from "../../reports/inv-reports.service";
import type { InvReportsExtendedService } from "../../reports/inv-reports-extended.service";
import {
  INV_REPORT_FILTERS,
  INV_REPORT_IDS,
  type InvReportId,
  type InvReportSpec,
} from "./dto/inv-report-spec.schemas";

/**
 * F5 — the table a report id resolves through.
 *
 * The model names a member of `INV_REPORT_IDS`. Everything that gives that name
 * meaning is here: which permission it costs to read, which it costs to export,
 * which columns it has, whether it takes a warehouse, and the function that runs
 * it. None of those is expressible in the model's output, so none of them can be
 * widened by anything the model says.
 *
 * Every report **delegates to the reports module's own service**, and that is
 * deliberate rather than convenient. Those services already carry the warehouse
 * predicate the direct report screen enforces; re-implementing the queries here
 * would create a second definition of "which rows may this person see", and the
 * second definition is always the one that ends up missing a clause. Reusing
 * them means the AI path and the ordinary path are the same path, gated at the
 * same place.
 *
 * `columns` is server-authored and is the only thing that decides what appears
 * in a preview or an export. A model has no say in projection, so it cannot ask
 * for a field the screen does not show.
 */

export type InvReportCell = string | number | null;

export interface InvReportColumn {
  /**
   * A dotted path into the service's row. Paths, not a bespoke mapper per
   * report, so a nested relation (`location.warehouse.name`) and a flat column
   * read the same way and a new report costs a list rather than a function.
   */
  path: string;
  label: string;
  numeric?: boolean;
}

export interface InvReportRunContext {
  orgId: string;
  userId: string;
  page: number;
  limit: number;
  reports: InvReportsService;
  extended: InvReportsExtendedService;
}

interface ReportRunResult {
  items: unknown[];
  total: number | null;
}

export interface InvReportDefinition {
  id: InvReportId;
  label: string;
  /**
   * Shown to the model when it chooses. Static text from this file — no tenant
   * row ever appears in the prompt that decides which report to run, which is
   * what makes a note written into a record unable to change the choice.
   */
  description: string;
  /** The permission the report's own screen requires. Checked against the asker. */
  viewPermission: string;
  /**
   * The permission taking the file costs, on top of `viewPermission`.
   *
   * The ledger is the audit trail of stock, so exporting it is
   * `inventory:audit:export` rather than the ordinary data export — an
   * immutable movement history leaving the building is a different act from a
   * position snapshot, and the catalog is where that distinction has to live or
   * it does not exist.
   */
  exportPermission: string;
  columns: readonly InvReportColumn[];
  /** Whether this report's filter shape has a `warehouseId` to scope. */
  takesWarehouse: boolean;
  run: (ctx: InvReportRunContext, spec: InvReportSpec) => Promise<ReportRunResult>;
}

/**
 * Narrow a validated spec to one report's own shape.
 *
 * An `asserts` signature rather than a returned value, so the narrowing is the
 * compiler's and not a cast: after this call `spec.filters` *is* that report's
 * filter type, and reaching the `movements` runner with an `expiry` spec is a
 * case the type system rules out rather than one this file has to remember to
 * check.
 *
 * The throw is unreachable in practice — the runner is looked up by the spec's
 * own id — and exists because "unreachable" is a claim that should fail loudly
 * rather than run the wrong query.
 */
function assertReport<K extends InvReportId>(
  spec: InvReportSpec,
  id: K,
): asserts spec is Extract<InvReportSpec, { report: K }> {
  if (spec.report !== id) {
    throw new Error(`inv-report-catalog: ${id} runner reached with a ${spec.report} spec`);
  }
}

const CATALOG: Readonly<Record<InvReportId, InvReportDefinition>> = {
  stock_summary: {
    id: "stock_summary",
    label: "Stock summary",
    description:
      "Current on-hand, committed and available quantity per SKU per location, with average cost. Answers 'what do we have and where'.",
    viewPermission: "inventory:reports:read",
    exportPermission: "inventory:export",
    takesWarehouse: false,
    columns: [
      { path: "productVariant.product.sku", label: "SKU" },
      { path: "productVariant.product.name", label: "Product" },
      { path: "location.warehouse.name", label: "Warehouse" },
      { path: "location.name", label: "Location" },
      { path: "onHand", label: "On hand", numeric: true },
      { path: "committed", label: "Committed", numeric: true },
      { path: "availableQty", label: "Available", numeric: true },
      { path: "averageCost", label: "Average cost", numeric: true },
    ],
    async run(ctx) {
      const result = await ctx.reports.getStockSummary(ctx.orgId, ctx.userId, {
        page: ctx.page,
        limit: ctx.limit,
      });
      return { items: result.items, total: result.total };
    },
  },

  reorder: {
    id: "reorder",
    label: "Reorder report",
    description:
      "SKUs at or below their reorder point, with the shortfall and the suggested order quantity. Answers 'what do we need to buy'.",
    viewPermission: "inventory:reports:read",
    exportPermission: "inventory:export",
    takesWarehouse: false,
    columns: [
      { path: "variantSku", label: "SKU" },
      { path: "productName", label: "Product" },
      { path: "onHand", label: "On hand", numeric: true },
      { path: "reorderPoint", label: "Reorder point", numeric: true },
      { path: "shortfall", label: "Shortfall", numeric: true },
    ],
    async run(ctx) {
      const result = await ctx.reports.getReorderReport(ctx.orgId, {
        page: ctx.page,
        limit: ctx.limit,
      });
      return { items: result.items, total: result.total };
    },
  },

  movements: {
    id: "movements",
    label: "Stock movements",
    description:
      "Ledger entries — receipts, sales, adjustments, transfers — with the quantity change, the balance after, who posted it and when. Takes a date range, a warehouse and a movement type. Answers 'what happened to the stock'.",
    viewPermission: "inventory:reports:read",
    // The ledger is the audit trail. Taking a copy of it is an audit export.
    exportPermission: "inventory:audit:export",
    takesWarehouse: true,
    columns: [
      { path: "createdAt", label: "Posted at" },
      { path: "productVariant.product.sku", label: "SKU" },
      { path: "transactionType", label: "Type" },
      { path: "location.warehouse.name", label: "Warehouse" },
      { path: "quantityChange", label: "Change", numeric: true },
      { path: "quantityAfter", label: "Balance after", numeric: true },
      { path: "creator.name", label: "Posted by" },
    ],
    async run(ctx, spec) {
      assertReport(spec, "movements");
      const filters = spec.filters;
      const result = await ctx.reports.getMovementsReport(ctx.orgId, ctx.userId, {
        page: ctx.page,
        limit: ctx.limit,
        ...(filters.fromDate !== undefined ? { fromDate: filters.fromDate } : {}),
        ...(filters.toDate !== undefined ? { toDate: filters.toDate } : {}),
        ...(filters.warehouseId !== undefined ? { warehouseId: filters.warehouseId } : {}),
        ...(filters.transactionType !== undefined
          ? { transactionType: filters.transactionType }
          : {}),
      });
      return { items: result.items, total: result.total };
    },
  },

  slow_moving: {
    id: "slow_moving",
    label: "Slow-moving stock",
    description:
      "SKUs with stock on hand and no outbound movement for a number of days, with the value tied up and the date it last moved. Answers 'what is not selling'.",
    viewPermission: "inventory:reports:read",
    exportPermission: "inventory:export",
    takesWarehouse: false,
    columns: [
      { path: "variantSku", label: "SKU" },
      { path: "productName", label: "Product" },
      { path: "onHandDec", label: "On hand", numeric: true },
      { path: "valueDec", label: "Value", numeric: true },
      { path: "lastMovement", label: "Last movement" },
      { path: "daysSinceLastMovement", label: "Days idle", numeric: true },
    ],
    async run(ctx, spec) {
      assertReport(spec, "slow_moving");
      const filters = spec.filters;
      const result = await ctx.extended.getSlowMovingReport(ctx.orgId, ctx.userId, {
        page: ctx.page,
        limit: ctx.limit,
        days: filters.days ?? 60,
      });
      return { items: result.items, total: result.total };
    },
  },

  expiry: {
    id: "expiry",
    label: "Expiring lots",
    description:
      "Lots with stock still on hand whose expiry date falls inside a horizon, with days remaining and lot status. Takes a horizon in days, a warehouse and a lot status. Answers 'what is about to go out of date'.",
    viewPermission: "inventory:reports:read",
    exportPermission: "inventory:export",
    takesWarehouse: true,
    columns: [
      { path: "lotNumber", label: "Lot" },
      { path: "variantSku", label: "SKU" },
      { path: "productName", label: "Product" },
      { path: "expiryDate", label: "Expires" },
      { path: "daysUntilExpiry", label: "Days left", numeric: true },
      { path: "totalOnHand", label: "On hand", numeric: true },
      { path: "status", label: "Status" },
    ],
    async run(ctx, spec) {
      assertReport(spec, "expiry");
      const filters = spec.filters;
      const result = await ctx.extended.getExpiryReport(ctx.orgId, ctx.userId, {
        page: ctx.page,
        limit: ctx.limit,
        withinDays: filters.withinDays ?? 30,
        ...(filters.warehouseId !== undefined ? { warehouseId: filters.warehouseId } : {}),
        ...(filters.status !== undefined ? { status: filters.status } : {}),
      });
      return { items: result.items, total: result.total };
    },
  },

  valuation: {
    id: "valuation",
    label: "Inventory valuation",
    description:
      "The value of stock on hand per SKU under the organisation's costing method, optionally as at a past date. Answers 'what is the stock worth'.",
    // A different key from the other five on purpose: what stock is worth is a
    // financial question, and holding the operational report key has never
    // bought the right to read it.
    viewPermission: "inventory:valuation:read",
    exportPermission: "inventory:export",
    takesWarehouse: true,
    columns: [
      { path: "variantSku", label: "SKU" },
      { path: "productName", label: "Product" },
      { path: "costingMethod", label: "Costing method" },
      { path: "onHand", label: "On hand", numeric: true },
      { path: "unitCostBasis", label: "Unit cost", numeric: true },
      { path: "value", label: "Value", numeric: true },
    ],
    async run(ctx, spec) {
      assertReport(spec, "valuation");
      const filters = spec.filters;
      const result = await ctx.extended.getValuationReport(ctx.orgId, ctx.userId, {
        page: ctx.page,
        limit: ctx.limit,
        ...(filters.warehouseId !== undefined ? { warehouseId: filters.warehouseId } : {}),
        ...(filters.categoryId !== undefined ? { categoryId: filters.categoryId } : {}),
        ...(filters.asOfDate !== undefined ? { asOfDate: filters.asOfDate } : {}),
      });
      return { items: result.items, total: result.total };
    },
  },
};

/**
 * Every id has a definition, and every definition's declared warehouse support
 * matches its filter shape. Both are checked at module load, because both fail
 * silently otherwise: a missing definition resolves to `undefined` and throws at
 * request time, and a `takesWarehouse` that disagrees with the schema would make
 * the scope check skip a filter that is actually accepted.
 */
const missing = INV_REPORT_IDS.filter((id) => !CATALOG[id]);
if (missing.length > 0) {
  throw new Error(`inv-report-catalog: no definition for ${missing.join(", ")}`);
}
for (const id of INV_REPORT_IDS) {
  const schemaTakesWarehouse = "warehouseId" in INV_REPORT_FILTERS[id].shape;
  if (schemaTakesWarehouse !== CATALOG[id].takesWarehouse) {
    throw new Error(
      `inv-report-catalog: ${id} declares takesWarehouse=${CATALOG[id].takesWarehouse} but its filter schema says ${schemaTakesWarehouse}`,
    );
  }
}

export const INV_REPORT_CATALOG = CATALOG;

/**
 * The catalogue the model is shown when it chooses. Assembled from this table so
 * the prompt cannot drift from the reports it describes, and containing no
 * tenant text at all.
 */
export function describeInvReports(): string {
  return INV_REPORT_IDS.map((id) => {
    const definition = CATALOG[id];
    const filters = Object.keys(INV_REPORT_FILTERS[id].shape);
    const filterNote = filters.length === 0 ? "no filters" : `filters: ${filters.join(", ")}`;
    return `- ${id}: ${definition.description} (${filterNote})`;
  }).join("\n");
}

/** Read a dotted path out of a service row, flattening to one printable cell. */
export function readPath(row: unknown, path: string): InvReportCell {
  let cursor: unknown = row;
  for (const segment of path.split(".")) {
    if (cursor === null || cursor === undefined || typeof cursor !== "object") return null;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  if (cursor === null || cursor === undefined) return null;
  if (typeof cursor === "string" || typeof cursor === "number") return cursor;
  if (typeof cursor === "boolean") return cursor ? "yes" : "no";
  if (cursor instanceof Date) return cursor.toISOString();
  // Anything else is a nested object the projection was not written for. It is
  // dropped rather than stringified: `[object Object]` in a report cell is worse
  // than an empty one, and a JSON blob in a CSV is a data leak with a comma in
  // it.
  return null;
}
