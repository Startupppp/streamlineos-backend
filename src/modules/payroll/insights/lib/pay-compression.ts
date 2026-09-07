/**
 * Pay compression / distribution analysis (Phase 8.2).
 * Cash CTC only — no protected attributes (gender, age, etc.).
 */

export interface PayCompressionMember {
  userId: string;
  annualCtc: number;
  label?: string | null;
}

export interface PayCompressionResult {
  mode: "cash_ctc_only";
  honestyNote: string;
  sampleSize: number;
  stats: {
    min: string;
    max: string;
    mean: string;
    median: string;
    p25: string;
    p75: string;
    compressionRatio: string | null;
  };
  /** Members outside [0.67×p25, 1.5×p75] when sample ≥ 4 */
  outliers: {
    userId: string;
    label: string | null;
    annualCtc: string;
    side: "below" | "above";
  }[];
  missingCtcCount: number;
}

function money(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const w = idx - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

/**
 * Analyze cash CTC distribution. Does not accept or use protected attributes.
 */
export function analyzePayCompression(
  members: PayCompressionMember[],
  missingCtcCount = 0,
): PayCompressionResult {
  const withCtc = members.filter((m) => m.annualCtc > 0);
  const sorted = withCtc.map((m) => m.annualCtc).sort((a, b) => a - b);

  const honestyNote =
    "Pay compression uses annual CTC only. No protected attributes (gender, age, caste, etc.) are used. This is an internal distribution signal, not a legal pay-equity audit.";

  if (sorted.length === 0) {
    return {
      mode: "cash_ctc_only",
      honestyNote,
      sampleSize: 0,
      stats: {
        min: "0.00",
        max: "0.00",
        mean: "0.00",
        median: "0.00",
        p25: "0.00",
        p75: "0.00",
        compressionRatio: null,
      },
      outliers: [],
      missingCtcCount,
    };
  }

  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const mean = sorted.reduce((s, n) => s + n, 0) / sorted.length;
  const median = percentile(sorted, 0.5);
  const p25 = percentile(sorted, 0.25);
  const p75 = percentile(sorted, 0.75);
  const compressionRatio = min > 0 ? max / min : null;

  const outliers: PayCompressionResult["outliers"] = [];
  if (sorted.length >= 4 && p25 > 0) {
    const low = p25 * 0.67;
    const high = p75 * 1.5;
    for (const m of withCtc) {
      if (m.annualCtc < low) {
        outliers.push({
          userId: m.userId,
          label: m.label ?? null,
          annualCtc: money(m.annualCtc),
          side: "below",
        });
      } else if (m.annualCtc > high) {
        outliers.push({
          userId: m.userId,
          label: m.label ?? null,
          annualCtc: money(m.annualCtc),
          side: "above",
        });
      }
    }
  }

  return {
    mode: "cash_ctc_only",
    honestyNote,
    sampleSize: sorted.length,
    stats: {
      min: money(min),
      max: money(max),
      mean: money(mean),
      median: money(median),
      p25: money(p25),
      p75: money(p75),
      compressionRatio:
        compressionRatio != null ? (Math.round(compressionRatio * 100) / 100).toFixed(2) : null,
    },
    outliers,
    missingCtcCount,
  };
}
