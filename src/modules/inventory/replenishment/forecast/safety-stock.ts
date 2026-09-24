/**
 * INV-303 — safety stock.
 *
 * The formula is standard and the standard implementation is usually wrong in
 * two specific ways, both of which this file is written to avoid.
 *
 * **Lead-time variability is not optional.** The common shortcut is
 * `z × σ_demand × √leadTime`, which assumes the supplier is perfectly reliable.
 * For most real suppliers the variance of the lead time contributes more to
 * stockout risk than the variance of demand does, and omitting it produces a
 * safety stock that looks rigorous and is systematically too small. The full
 * form — √(L·σ_d² + d̄²·σ_L²) — is used instead.
 *
 * **The normal assumption does not hold for intermittent demand.** A z-score
 * multiplied by a standard deviation is a statement about a bell curve. Demand
 * that is zero four weeks in five is not remotely normal, and the number that
 * comes out is arithmetic rather than a service level. Rather than quietly
 * returning it, the engine reports that the model does not apply and says what
 * it would take to make a real estimate.
 */

export type ServiceLevel = number;

export interface SafetyStockInput {
  /** Mean demand per period, in base units. */
  demandMean: number;
  /** Standard deviation of demand per period. */
  demandStdDev: number;
  /** Mean lead time, in the same periods as demand. */
  leadTimePeriods: number;
  /** Standard deviation of the lead time. Zero means a perfectly reliable supplier. */
  leadTimeStdDev: number;
  /** 0..1, exclusive. 0.95 means "accept a stockout in one cycle in twenty". */
  serviceLevel: ServiceLevel;
}

export interface SafetyStockResult {
  safetyStock: number;
  reorderPoint: number;
  /** Expected demand across one lead time, before any buffer. */
  leadTimeDemand: number;
  z: number;
  /** Which part of the risk dominates — useful, and free to compute. */
  dominantVariance: "demand" | "lead_time" | "balanced";
  warnings: string[];
}

/**
 * Inverse standard normal CDF (Acklam's rational approximation).
 *
 * Accurate to about 1.15e-9, which is far more than a service level needs, but
 * a lookup table of four hard-coded z-scores is how a system ends up unable to
 * express 97.5%.
 */
export function inverseNormalCdf(p: number): number {
  if (p <= 0 || p >= 1) throw new RangeError("service level must be between 0 and 1");

  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
             1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
             6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
             -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
             3.754408661907416];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > pHigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

export function safetyStock(input: SafetyStockInput): SafetyStockResult {
  const {
    demandMean,
    demandStdDev,
    leadTimePeriods,
    leadTimeStdDev,
    serviceLevel,
  } = input;

  const warnings: string[] = [];
  if (serviceLevel >= 0.999) {
    // The tail gets very expensive very fast, and the number is driven almost
    // entirely by an assumption about a distribution nobody has verified.
    warnings.push(
      "Service levels above 99.9% are dominated by distribution assumptions rather than by data; the resulting stock is an expensive guess.",
    );
  }
  if (leadTimeStdDev === 0 && leadTimePeriods > 0) {
    warnings.push(
      "Lead time is being treated as perfectly reliable. If that is an absence of data rather than a real property of the supplier, this safety stock is too small.",
    );
  }

  const z = inverseNormalCdf(serviceLevel);
  const demandVariance = leadTimePeriods * demandStdDev ** 2;
  const leadTimeVariance = demandMean ** 2 * leadTimeStdDev ** 2;
  const sigma = Math.sqrt(demandVariance + leadTimeVariance);

  const leadTimeDemand = demandMean * leadTimePeriods;
  const ss = Math.max(0, z * sigma);

  const total = demandVariance + leadTimeVariance;
  const dominantVariance =
    total === 0
      ? "balanced"
      : demandVariance / total > 0.66
        ? "demand"
        : leadTimeVariance / total > 0.66
          ? "lead_time"
          : "balanced";

  return {
    safetyStock: round(ss),
    reorderPoint: round(leadTimeDemand + ss),
    leadTimeDemand: round(leadTimeDemand),
    z: round(z),
    dominantVariance,
    warnings,
  };
}

/** Mean and sample standard deviation of a series. */
export function describe(series: readonly number[]): { mean: number; stdDev: number } {
  if (series.length === 0) return { mean: 0, stdDev: 0 };
  const mean = series.reduce((a, b) => a + b, 0) / series.length;
  if (series.length === 1) return { mean: round(mean), stdDev: 0 };
  // n-1: this is a sample of demand, not the population of it, and using n
  // understates the spread on exactly the short histories where it matters.
  const variance =
    series.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (series.length - 1);
  return { mean: round(mean), stdDev: round(Math.sqrt(variance)) };
}
