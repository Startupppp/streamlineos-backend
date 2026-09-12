import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";
import { itemsPagedSchema } from "../../../../common/openapi/response-envelopes";

/**
 * C1–C7 — the forecasting and drift surfaces on the wire.
 *
 * One distinction runs through every shape here and is the reason the types are
 * not interchangeable: a **quantity** is an exact `numeric(18,4)` decimal string
 * and a **statistic** is a float. A safety stock somebody buys against is the
 * first; a mean, a standard deviation, a z-score and every accuracy metric are
 * the second. Declaring either as the other would make the contract agree with
 * the bug `exact.ts` exists to prevent.
 */
const accuracyMetricsSchema = z.object({
  n: z.number().int(),
  mae: z.number(),
  rmse: z.number(),
  /** Signed: positive means the forecast ran high. */
  bias: z.number(),
  mase: z.number().nullable(),
});

const backtestResultSchema = z.object({
  method: z.string(),
  metrics: accuracyMetricsSchema,
});

const demandPointSchema = z.object({
  period: z.string(),
  quantity: z.string(),
  closingOnHand: z.string(),
  stockoutCensored: z.boolean(),
});

export const baselineResponseSchema = z.object({
  productVariantId: z.number().int(),
  warehouseId: z.number().int().nullable(),
  periods: z.number().int(),
  history: z.array(demandPointSchema),
  classification: z.object({
    category: z.string(),
    adi: z.number(),
    cv2: z.number(),
    nonZeroPeriods: z.number().int(),
    guidance: z.string(),
  }),
  seasonality: z.object({
    seasonLength: z.number().int().nullable(),
    strength: z.number(),
    candidates: z.array(z.object({ lag: z.number().int(), correlation: z.number() })),
  }),
  ranked: z.array(backtestResultSchema),
  champion: backtestResultSchema.nullable(),
  /** Best by error alone. Reported separately when it disagrees with the champion. */
  unrestrictedBest: backtestResultSchema.nullable(),
  censoredPeriods: z.number().int(),
  stockoutCensored: z.boolean(),
  coverage: z.object({ from: z.string(), to: z.string() }),
  shapeNote: z.string().optional(),
  insufficientReason: z.string().optional(),
  censoringNote: z.string().optional(),
});

/** `ForecastVersion` — the stored row, mapped; never the raw ORM row. */
const forecastVersionSchema = z.object({
  id: z.number().int(),
  productVariantId: z.number().int(),
  warehouseId: z.number().int().nullable(),
  /** Already `.toISOString()`-ed by `toVersion`, so a string rather than a `Date`. */
  generatedAt: z.string(),
  historyWeeks: z.number().int(),
  horizonWeeks: z.number().int(),
  periods: z.number().int(),
  coverage: z.object({ from: z.string(), to: z.string() }),
  method: z.string().nullable(),
  demandCategory: z.string(),
  seasonLength: z.number().int().nullable(),
  metrics: z
    .object({
      mae: z.string(),
      rmse: z.string(),
      bias: z.string(),
      mase: z.string().nullable(),
    })
    .nullable(),
  serviceLevel: z.string(),
  applicable: z.boolean(),
  refusalReason: z.string().nullable(),
  safetyStock: z.string().nullable(),
  reorderPoint: z.string().nullable(),
  leadTimeDemand: z.string().nullable(),
  z: z.string().nullable(),
  demand: z.object({ mean: z.string(), stdDev: z.string() }),
  leadTime: z.object({
    weeks: z.string(),
    stdDevWeeks: z.string(),
    observations: z.number().int(),
  }),
  censoredPeriods: z.number().int(),
  stockoutCensored: z.boolean(),
  /** A stored snapshot document; its keys are the run's own, not a fixed set. */
  assumptions: z.record(z.string(), z.unknown()),
  inputFingerprint: z.string(),
});

export const generateForecastVersionResponseSchema = z.object({
  version: forecastVersionSchema,
  /** False when the fingerprint landed on a row that already existed. */
  created: z.boolean(),
});

export const listForecastVersionsResponseSchema = itemsPagedSchema(forecastVersionSchema);

/** Null when nothing has been recorded for this variant and scope yet. */
export const latestForecastVersionResponseSchema = forecastVersionSchema.nullable();

export const refreshForecastVersionsResponseSchema = z.object({
  scanned: z.number().int(),
  recorded: z.number().int(),
  unchanged: z.number().int(),
  /** One unforecastable SKU must not deny the buyer the rest of the sweep. */
  failed: z.array(z.object({ productVariantId: z.number().int(), reason: z.string() })),
});

export const safetyStockPolicyResponseSchema = z.object({
  productVariantId: z.number().int(),
  warehouseId: z.number().int().nullable(),
  serviceLevel: z.number(),
  demandCategory: z.string(),
  demand: z.object({ mean: z.number(), stdDev: z.number(), periods: z.number().int() }),
  leadTime: z.object({
    periods: z.number(),
    stdDev: z.number(),
    observations: z.number().int(),
  }),
  /** Null when the normal model does not describe this demand shape. */
  policy: z
    .object({
      safetyStock: z.number(),
      reorderPoint: z.number(),
      leadTimeDemand: z.number(),
      z: z.number(),
      dominantVariance: z.enum(["demand", "lead_time", "balanced"]),
      warnings: z.array(z.string()),
    })
    .nullable(),
  applicable: z.boolean(),
  refusalReason: z.string().nullable(),
  stockoutCensored: z.boolean(),
  censoredPeriods: z.number().int(),
  notes: z.array(z.string()),
});

export const vendorLeadTimeResponseSchema = z.object({
  vendorId: z.number().int(),
  observations: z.number().int(),
  meanDays: z.number(),
  stdDevDays: z.number(),
  p50Days: z.number(),
  /** The number a planner can actually keep a promise against. */
  p90Days: z.number(),
  reliable: z.boolean(),
  note: z.string().optional(),
});

/**
 * Every figure a buyer acts on is exact. The estimates behind them stay in
 * `safetyStockPolicyResponseSchema`, where they are labelled as statistics.
 */
export const reorderProposalResponseSchema = z.object({
  productVariantId: z.number().int(),
  warehouseId: z.number().int().nullable(),
  suggestedQuantity: z.string().nullable(),
  position: z.object({
    onHand: z.string(),
    committed: z.string(),
    onOrder: z.string(),
    available: z.string(),
  }),
  reorderPoint: z.string().nullable(),
  evidence: z.array(
    z.object({ label: z.string(), value: z.string(), source: z.string() }),
  ),
  caveats: z.array(z.string()),
  recommendation: z.enum(["propose", "review", "hold"]),
});

const simulationOutcomeSchema = z.object({
  label: z.string(),
  serviceLevel: z.number(),
  demandMean: z.number(),
  leadTimeWeeks: z.number(),
  safetyStock: z.number(),
  reorderPoint: z.number(),
  /** Against the measured baseline: positive means this scenario holds more. */
  deltaSafetyStock: z.number(),
  deltaReorderPoint: z.number(),
});

export const simulateReplenishmentResponseSchema = z.object({
  productVariantId: z.number().int(),
  warehouseId: z.number().int().nullable(),
  applicable: z.boolean(),
  reason: z.string().optional(),
  baseline: simulationOutcomeSchema.nullable(),
  scenarios: z.array(simulationOutcomeSchema),
  caveats: z.array(z.string()),
});

/**
 * C7 — the drift watchlist.
 *
 * `coverage.from`/`to` are `date` columns read through `db.execute`, and
 * postgres-js parses a date OID into a `Date` before drizzle sees it — unlike
 * the query-builder reads above, where drizzle hands back the text. Both are
 * accepted rather than guessed at, because the value that reaches the
 * interceptor depends on which of the two paths produced the row.
 */
const rawDateSchema = z.union([wireDate(), z.string()]);

const driftWatchRowSchema = z.object({
  forecastId: z.number().int(),
  productVariantId: z.number().int(),
  variantSku: z.string(),
  productName: z.string(),
  warehouseId: z.number().int().nullable(),
  warehouseName: z.string().nullable(),
  method: z.string().nullable(),
  generatedAt: z.string(),
  mae: z.string().nullable(),
  rmse: z.string().nullable(),
  bias: z.string().nullable(),
  mase: z.string().nullable(),
  demandMean: z.string(),
  /** MAE relative to mean weekly demand. Null when the SKU sells nothing. */
  maeRatio: z.string().nullable(),
  breachesThreshold: z.boolean(),
  stale: z.boolean(),
  ageDays: z.number(),
  coverage: z.object({
    periods: z.number().int(),
    from: rawDateSchema,
    to: rawDateSchema,
    censoredPeriods: z.number().int(),
    stockoutCensored: z.boolean(),
  }),
  applicable: z.boolean(),
  refusalReason: z.string().nullable(),
  storedVersions: z.number().int(),
});

/** Rates are reported to two places; a zero denominator is "0.00", never NaN. */
const driftSummarySchema = z.object({
  tracked: z.number().int(),
  breaching: z.number().int(),
  stale: z.number().int(),
  refused: z.number().int(),
  coverage: z.object({
    variantsForecast: z.number().int(),
    variantsTotal: z.number().int(),
    percent: z.string(),
  }),
  proposals: z.object({
    total: z.number().int(),
    accepted: z.number().int(),
    acceptedPercent: z.string(),
    refusals: z.number().int(),
    overridden: z.number().int(),
    overriddenPercent: z.string(),
  }),
});

export const driftWatchlistResponseSchema = itemsPagedSchema(driftWatchRowSchema).extend({
  threshold: z.number(),
  summary: driftSummarySchema,
});

export const driftDetailResponseSchema = z.object({
  report: z.object({
    productVariantId: z.number().int(),
    warehouseId: z.number().int().nullable(),
    method: z.string().nullable(),
    earlier: accuracyMetricsSchema.nullable(),
    recent: accuracyMetricsSchema.nullable(),
    /** Recent MAE over earlier MAE. Above 1 means it got worse. */
    maeRatio: z.number().nullable(),
    status: z.enum(["stable", "degrading", "improving", "insufficient_data"]),
    championChanged: z.boolean(),
    previousChampion: z.string().optional(),
    findings: z.array(z.string()),
  }),
  /** The stored rows the number came from — the evidence link's destination. */
  evidence: z.object({
    productVariantId: z.number().int(),
    warehouseId: z.number().int().nullable(),
    totalVersions: z.number().int(),
    versions: z.array(forecastVersionSchema),
  }),
});

/**
 * C6 — batching persisted proposals into purchase orders.
 *
 * Every quantity and money figure here is exact. `unitCost`, `lineValue` and
 * `totalValue` are what a buyer signs against, so none of them is ever a float.
 */
export const batchableProposalsResponseSchema = itemsPagedSchema(
  z.object({
    proposalId: z.number().int(),
    productVariantId: z.number().int(),
    variantSku: z.string(),
    productName: z.string(),
    warehouseId: z.number().int().nullable(),
    warehouseName: z.string().nullable(),
    vendorId: z.number().int().nullable(),
    vendorName: z.string().nullable(),
    currency: z.string().nullable(),
    generatedAt: z.string(),
    reorderPoint: z.string().nullable(),
    /** What the server would order today — never a quantity the caller sent. */
    suggestedQuantity: z.string(),
    unitCost: z.string(),
    duplicateOfPoNumber: z.string().nullable(),
    blockedReason: z.string().nullable(),
  }),
);

const batchLineSchema = z.object({
  productVariantId: z.number().int(),
  productName: z.string(),
  requested: z.string(),
  ordered: z.string(),
  /** The engine's own answer, carried beside `ordered` so a human number is legible as one. */
  engineOrdered: z.string(),
  override: z.object({ requested: z.string(), reason: z.string() }).nullable(),
  unitCost: z.string(),
  lineValue: z.string(),
  excess: z.string(),
  reasons: z.array(z.string()),
});

export const previewPoBatchResponseSchema = z.object({
  batches: z.array(
    z.object({
      vendorId: z.number().int(),
      vendorName: z.string(),
      warehouseId: z.number().int().nullable(),
      warehouseName: z.string().nullable(),
      currency: z.string(),
      lines: z.array(batchLineSchema),
      totalValue: z.string(),
      /** Units bought beyond need, so the cost of the pack-size policy is visible. */
      totalExcessUnits: z.string(),
      requiresApproval: z.boolean(),
      approvalReason: z.string().optional(),
    }),
  ),
  /** Proposals that produce no order line, and why. Never silently dropped. */
  skipped: z.array(
    z.object({
      proposalId: z.number().int(),
      productVariantId: z.number().int(),
      reason: z.string(),
    }),
  ),
  requiresApproval: z.boolean(),
});

export const createPoBatchResponseSchema = z.object({
  poId: z.number().int(),
  poNumber: z.string(),
  vendorId: z.number().int(),
  warehouseId: z.number().int().nullable(),
  currency: z.string(),
  lineCount: z.number().int(),
  total: z.string(),
  requiresApproval: z.boolean(),
  /** What has to happen before goods can be expected. */
  nextStep: z.string(),
  created: z.boolean(),
});

/**
 * C5 — the transfer plan.
 *
 * The split between exact and estimated runs through this shape too: the ledger
 * positions are decimal strings, and everything measured in weeks of cover is a
 * rate and stays a float.
 */
export const transferPlanResponseSchema = z.object({
  productVariantId: z.number().int(),
  positions: z.array(
    z.object({
      warehouseId: z.number().int(),
      warehouseName: z.string(),
      onHand: z.string(),
      committed: z.string(),
      available: z.string(),
      weeklyDemand: z.number(),
      weeksOfCover: z.number().nullable(),
    }),
  ),
  recommendations: z.array(
    z.object({
      fromWarehouseId: z.number().int(),
      fromWarehouseName: z.string(),
      toWarehouseId: z.number().int(),
      toWarehouseName: z.string(),
      quantity: z.number(),
      /** Cover at each end after the move, so the trade is visible. */
      coverAfter: z.object({
        from: z.number().nullable(),
        to: z.number().nullable(),
      }),
      rationale: z.string(),
    }),
  ),
  caveats: z.array(z.string()),
});

export const approveTransferRecommendationResponseSchema = z.object({
  transferId: z.number().int(),
  referenceNumber: z.string(),
  productVariantId: z.number().int(),
  fromWarehouseId: z.number().int(),
  toWarehouseId: z.number().int(),
  fromLocationId: z.number().int(),
  toLocationId: z.number().int(),
  /** The server's quantity, re-derived from the plan. Never the caller's. */
  quantity: z.string(),
  allocations: z.array(
    z.object({
      lotId: z.number().int().nullable(),
      lotNumber: z.string().nullable(),
      expiryDate: z.string().nullable(),
      quantity: z.string(),
    }),
  ),
  /** Always PENDING: approving a recommendation does not hold the stock. */
  status: z.string(),
  created: z.boolean(),
});
