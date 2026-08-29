import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { invDemandForecasts } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { DemandBaselineService } from "./demand-baseline.service";
import { SafetyStockPolicyService } from "./safety-stock-policy.service";
import { toExact } from "./exact";

/** The shape of the fingerprint payload. Bump when the inputs change meaning. */
const FINGERPRINT_VERSION = 1;

/** How far ahead a stored version speaks, when the caller does not say. */
const DEFAULT_HORIZON_WEEKS = 4;

export interface GenerateForecastInput {
  productVariantId: number;
  /** Null means the whole organisation. Already gated by `DemandBaselineService.scopeFor`. */
  warehouseId: number | null;
  historyWeeks?: number;
  horizonWeeks?: number;
  serviceLevel?: number;
}

export interface ForecastVersion {
  id: number;
  productVariantId: number;
  warehouseId: number | null;
  generatedAt: string;
  historyWeeks: number;
  horizonWeeks: number;
  periods: number;
  coverage: { from: string; to: string };
  method: string | null;
  demandCategory: string;
  seasonLength: number | null;
  /** Backtest accuracy of the champion. Null when no method could be justified. */
  metrics: { mae: string; rmse: string; bias: string; mase: string | null } | null;
  serviceLevel: string;
  applicable: boolean;
  refusalReason: string | null;
  safetyStock: string | null;
  reorderPoint: string | null;
  leadTimeDemand: string | null;
  z: string | null;
  demand: { mean: string; stdDev: string };
  leadTime: { weeks: string; stdDevWeeks: string; observations: number };
  censoredPeriods: number;
  stockoutCensored: boolean;
  assumptions: Record<string, unknown>;
  inputFingerprint: string;
}

type ForecastRow = typeof invDemandForecasts.$inferSelect;

/**
 * C1 — the forecast, kept.
 *
 * The engine recomputed on every read and remembered nothing, so nobody could
 * ask the only question that matters about a forecast: was the one we made last
 * quarter any good. Recomputing last quarter's forecast from today's ledger does
 * not answer it — the ledger has since learned what happened, and a rolling
 * backtest over it is a different claim.
 *
 * Two design decisions, both stated in `0541` and repeated here because a reader
 * lands in one place or the other:
 *
 * **History, not a latest-value row.** An UPDATE in place destroys the evidence
 * the table exists to hold. "Latest" is one indexed query over history; history
 * cannot be recovered from latest.
 *
 * **Keyed on the inputs, not on the clock.** A read surface that appended a row
 * per call would produce a log of who looked, not a history of what was
 * forecast. `input_fingerprint` is a SHA-256 over the exact inputs, so the same
 * fixture lands on the row that already exists and a genuinely different one
 * appends. That is also what makes the phase's own acceptance test mean
 * something: two calls over the same fixture produce the *same stored version*,
 * by construction rather than by luck.
 *
 * A refusal is stored like any other version. An intermittent SKU that the
 * normal-distribution model cannot describe is not an absent row — it is a row
 * that says `applicable = false` and why, and the CHECK constraint in `0541`
 * makes the "refused, no reason" state unrepresentable.
 */
@Injectable()
export class ForecastPersistenceService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly baselines: DemandBaselineService,
    private readonly policies: SafetyStockPolicyService,
  ) {}

  /**
   * Compute a forecast for this variant and scope, and store the version.
   *
   * Idempotent by construction: the fingerprint covers everything the arithmetic
   * read, so calling twice over unchanged data returns the row the first call
   * wrote rather than a second one that says the same thing.
   */
  async generate(
    orgId: string,
    userId: string,
    input: GenerateForecastInput,
  ): Promise<{ version: ForecastVersion; created: boolean }> {
    const historyWeeks = Math.min(Math.max(input.historyWeeks ?? 52, 1), 260);
    const horizonWeeks = Math.min(Math.max(input.horizonWeeks ?? DEFAULT_HORIZON_WEEKS, 1), 52);
    const serviceLevel = input.serviceLevel ?? 0.95;
    const { productVariantId, warehouseId } = input;

    const [baseline, policy] = await Promise.all([
      this.baselines.baseline(orgId, productVariantId, {
        weeks: historyWeeks,
        warehouseId,
      }),
      this.policies.policyFor(orgId, productVariantId, {
        weeks: historyWeeks,
        warehouseId,
        serviceLevel,
      }),
    ]);

    // Everything the arithmetic actually read. The demand series is in here in
    // full and exactly as it left Postgres, because that is what makes the
    // fingerprint a statement about the *inputs* rather than about the clock:
    // one new sale changes it, a second read on the same afternoon does not.
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          v: FINGERPRINT_VERSION,
          productVariantId,
          warehouseId,
          historyWeeks,
          horizonWeeks,
          serviceLevel,
          series: baseline.history.map((p) => [
            p.period,
            p.quantity,
            p.stockoutCensored ? 1 : 0,
          ]),
          leadTime: [
            policy.leadTime.periods,
            policy.leadTime.stdDev,
            policy.leadTime.observations,
          ],
        }),
      )
      .digest("hex");

    const refusalReason = policy.applicable
      ? null
      : (policy.refusalReason ??
        baseline.insufficientReason ??
        "The safety-stock model does not describe this demand.");

    const metrics = baseline.champion?.metrics ?? null;

    const values: typeof invDemandForecasts.$inferInsert = {
      orgId,
      productVariantId,
      warehouseId,
      historyWeeks,
      horizonWeeks,
      periods: baseline.periods,
      coverageFrom: baseline.coverage.from,
      coverageTo: baseline.coverage.to,
      method: baseline.champion?.method ?? null,
      demandCategory: policy.demandCategory,
      adi: toExact(baseline.classification.adi),
      cv2: toExact(baseline.classification.cv2),
      seasonLength: baseline.seasonality.seasonLength,
      mae: metrics ? toExact(metrics.mae) : null,
      rmse: metrics ? toExact(metrics.rmse) : null,
      bias: metrics ? toExact(metrics.bias) : null,
      mase: metrics && metrics.mase !== null ? toExact(metrics.mase) : null,
      serviceLevel: serviceLevel.toFixed(4),
      applicable: policy.applicable,
      refusalReason,
      // The three quantities. `toExact` is the one crossing back from a
      // statistical estimate to a number somebody buys against; the CHECK in
      // 0541 requires all three together or none of them.
      safetyStock: policy.policy ? toExact(policy.policy.safetyStock) : null,
      reorderPoint: policy.policy ? toExact(policy.policy.reorderPoint) : null,
      leadTimeDemand: policy.policy ? toExact(policy.policy.leadTimeDemand) : null,
      z: policy.policy ? policy.policy.z.toFixed(6) : null,
      demandMean: toExact(policy.demand.mean),
      demandStdDev: toExact(policy.demand.stdDev),
      leadTimeWeeks: toExact(policy.leadTime.periods),
      leadTimeStdDevWeeks: toExact(policy.leadTime.stdDev),
      leadTimeObservations: policy.leadTime.observations,
      censoredPeriods: baseline.censoredPeriods,
      stockoutCensored: baseline.stockoutCensored,
      assumptions: {
        demandDefinition:
          "SALE and RESERVATION_CONSUME movements, dense weekly periods, zeros included",
        scope: warehouseId === null ? "organisation" : `warehouse:${warehouseId}`,
        leadTimeSource:
          policy.leadTime.observations >= 3
            ? "measured from goods receipts"
            : "configured default — too few receipts to measure",
        methodRestriction: baseline.shapeNote ?? null,
        censoringNote: baseline.censoringNote ?? null,
        insufficientReason: baseline.insufficientReason ?? null,
        caveats: policy.notes,
        // The ranking that produced the champion, so "why this method" is
        // answerable later without re-running a backtest against a ledger that
        // has moved. A snapshot document, not a collection anybody paginates.
        ranking: baseline.ranked.map((r) => ({ method: r.method, mae: r.metrics.mae })),
      },
      inputFingerprint: fingerprint,
      generatedBy: userId,
    };

    // Append-only: never an UPDATE. A conflict means this exact forecast has
    // already been recorded, and the row that exists is the answer.
    const [inserted] = await this.db
      .insert(invDemandForecasts)
      .values(values)
      .onConflictDoNothing()
      .returning();

    if (inserted) return { version: toVersion(inserted), created: true };

    const existing = await this.findByFingerprint(
      orgId,
      productVariantId,
      warehouseId,
      fingerprint,
    );
    if (!existing) {
      // The only way here is a conflict on some other unique constraint, which
      // would be a bug rather than a race. Fail loudly instead of returning a
      // forecast nobody stored.
      throw new Error("Forecast version could not be stored or re-read");
    }
    return { version: existing, created: false };
  }

  /**
   * C2 — record a proposal for every SKU at this site that has recent demand.
   *
   * The per-variant `generate` above has existed since C1 and nothing called it
   * from a screen, so `inv_demand_forecasts` stayed empty in every organisation
   * that had not POSTed to the API by hand — and a replenishment page that
   * reviews persisted proposals had nothing to review. That is not a missing
   * endpoint, it is a missing *entry point*, and this is it.
   *
   * The candidate set is demand, not a min/max rule. A forecast is a statement
   * about what has been selling; picking SKUs by whether somebody has configured
   * a reorder rule would put the static policy back in charge of what the engine
   * is even allowed to speak about, which is the arrangement C2 removes.
   *
   * Bounded on purpose. Each version costs a demand baseline, a backtest and a
   * lead-time read, so this is a capped sweep a buyer triggers rather than an
   * unbounded catalogue rebuild — and it is sequential, because running fifty
   * backtests concurrently against Neon is how one screen refresh becomes an
   * outage. A variant whose forecast fails is reported, not thrown: one
   * unforecastable SKU must not deny the buyer the other forty-nine.
   */
  async refresh(
    orgId: string,
    userId: string,
    options: { warehouseId: number | null; limit: number; historyWeeks?: number },
  ): Promise<{
    scanned: number;
    recorded: number;
    unchanged: number;
    failed: Array<{ productVariantId: number; reason: string }>;
  }> {
    const { warehouseId, limit } = options;
    const warehouseFilter =
      warehouseId === null
        ? sql`TRUE`
        : sql`EXISTS (
            SELECT 1 FROM inv_locations wh_loc
            WHERE wh_loc.id = st.location_id
              AND wh_loc.org_id = st.org_id
              AND wh_loc.warehouse_id = ${warehouseId}
          )`;

    const rows = await this.db.execute<{ product_variant_id: number }>(sql`
      SELECT st.product_variant_id
      FROM inv_stock_transactions st
      WHERE st.org_id = ${orgId}
        AND st.transaction_type IN ('SALE', 'RESERVATION_CONSUME')
        AND st.created_at >= now() - interval '1 year'
        AND ${warehouseFilter}
      GROUP BY st.product_variant_id
      ORDER BY max(st.created_at) DESC
      LIMIT ${limit}
    `);

    let recorded = 0;
    let unchanged = 0;
    const failed: Array<{ productVariantId: number; reason: string }> = [];

    for (const row of rows) {
      const productVariantId = Number(row.product_variant_id);
      try {
        const { created } = await this.generate(orgId, userId, {
          productVariantId,
          warehouseId,
          historyWeeks: options.historyWeeks,
        });
        if (created) recorded += 1;
        else unchanged += 1;
      } catch (error: unknown) {
        failed.push({
          productVariantId,
          reason: error instanceof Error ? error.message : "The forecast could not be recorded.",
        });
      }
    }

    return { scanned: rows.length, recorded, unchanged, failed };
  }

  /** The most recent stored version for this variant and scope, or null. */
  async latest(
    orgId: string,
    productVariantId: number,
    warehouseId: number | null,
  ): Promise<ForecastVersion | null> {
    const [row] = await this.db
      .select()
      .from(invDemandForecasts)
      .where(
        and(
          eq(invDemandForecasts.orgId, orgId),
          eq(invDemandForecasts.productVariantId, productVariantId),
          sql`${invDemandForecasts.warehouseId} IS NOT DISTINCT FROM ${warehouseId}`,
        ),
      )
      .orderBy(desc(invDemandForecasts.generatedAt), desc(invDemandForecasts.id))
      .limit(1);
    return row ? toVersion(row) : null;
  }

  /**
   * The stored history, newest first. Paginated and hard-capped like every other
   * list (§3): this is the surface somebody will point a chart at.
   */
  async versions(
    orgId: string,
    productVariantId: number,
    warehouseId: number | null,
    options: { page?: number; limit?: number } = {},
  ): Promise<{ items: ForecastVersion[]; total: number; page: number; totalPages: number }> {
    const page = Math.max(1, options.page ?? 1);
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const where = and(
      eq(invDemandForecasts.orgId, orgId),
      eq(invDemandForecasts.productVariantId, productVariantId),
      sql`${invDemandForecasts.warehouseId} IS NOT DISTINCT FROM ${warehouseId}`,
    );

    const [rows, [countRow]] = await Promise.all([
      this.db
        .select()
        .from(invDemandForecasts)
        .where(where)
        .orderBy(desc(invDemandForecasts.generatedAt), desc(invDemandForecasts.id))
        .limit(limit)
        .offset((page - 1) * limit),
      this.db
        .select({ total: sql<number>`count(*)::int` })
        .from(invDemandForecasts)
        .where(where),
    ]);

    const total = countRow?.total ?? 0;
    return {
      items: rows.map(toVersion),
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  private async findByFingerprint(
    orgId: string,
    productVariantId: number,
    warehouseId: number | null,
    fingerprint: string,
  ): Promise<ForecastVersion | null> {
    const [row] = await this.db
      .select()
      .from(invDemandForecasts)
      .where(
        and(
          eq(invDemandForecasts.orgId, orgId),
          eq(invDemandForecasts.productVariantId, productVariantId),
          sql`${invDemandForecasts.warehouseId} IS NOT DISTINCT FROM ${warehouseId}`,
          eq(invDemandForecasts.inputFingerprint, fingerprint),
        ),
      )
      .limit(1);
    return row ? toVersion(row) : null;
  }
}

/**
 * Rows never leave the service raw (§1). Quantities stay decimal strings on the
 * way out, because rounding them into a JSON number is the one step that would
 * make a stored exact figure inexact again.
 */
function toVersion(row: ForecastRow): ForecastVersion {
  return {
    id: row.id,
    productVariantId: row.productVariantId,
    warehouseId: row.warehouseId,
    generatedAt: row.generatedAt.toISOString(),
    historyWeeks: row.historyWeeks,
    horizonWeeks: row.horizonWeeks,
    periods: row.periods,
    coverage: { from: row.coverageFrom, to: row.coverageTo },
    method: row.method,
    demandCategory: row.demandCategory,
    seasonLength: row.seasonLength,
    metrics:
      row.mae === null || row.rmse === null || row.bias === null
        ? null
        : { mae: row.mae, rmse: row.rmse, bias: row.bias, mase: row.mase },
    serviceLevel: row.serviceLevel,
    applicable: row.applicable,
    refusalReason: row.refusalReason,
    safetyStock: row.safetyStock,
    reorderPoint: row.reorderPoint,
    leadTimeDemand: row.leadTimeDemand,
    z: row.z,
    demand: { mean: row.demandMean, stdDev: row.demandStdDev },
    leadTime: {
      weeks: row.leadTimeWeeks,
      stdDevWeeks: row.leadTimeStdDevWeeks,
      observations: row.leadTimeObservations,
    },
    censoredPeriods: row.censoredPeriods,
    stockoutCensored: row.stockoutCensored,
    assumptions: row.assumptions,
    inputFingerprint: row.inputFingerprint,
  };
}
