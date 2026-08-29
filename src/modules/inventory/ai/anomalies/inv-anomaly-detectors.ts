import type { InvEvidenceKind } from "../dto/inv-ai-contract";

/**
 * F3 — what each detector actually claims, written down once.
 *
 * The six detectors already existed and already wrote rows. What they never
 * carried was the thing that makes a finding reviewable rather than merely
 * readable: **the formula it applied and the window it applied it over**.
 * "Stockout risk: SKU-7" is an assertion; "available (12.00) is below the mean
 * weekly sales of the last 90 days (31.40)" is an assertion somebody can
 * disagree with, which is the only kind worth putting in a queue.
 *
 * The windows live here and the detectors read them from here. That direction
 * matters. A registry that restated constants defined elsewhere would describe
 * the detector as it was on the day somebody wrote the description, and the
 * first threshold change would make the queue quietly lie about its own
 * arithmetic. There is one number and both the query and the caption use it.
 *
 * Each finding also stores its window on the row (`inv_ai_insights.window_days`),
 * so a threshold changed next month does not retroactively rewrite what last
 * month's alert said. The registry is what a detector means *now*; the column is
 * what it meant *then*.
 */

export const INV_ANOMALY_TYPES = [
  "stockout_risk",
  "dead_stock",
  "vendor_delay",
  "negative_stock",
  "unusual_adjustments",
  "expiry_risk",
] as const;
export type InvAnomalyType = (typeof INV_ANOMALY_TYPES)[number];

/**
 * The observation windows, in days. Imported by the detectors themselves —
 * these are not a second copy.
 */
export const ANOMALY_WINDOWS = {
  /** Demand is averaged over a quarter: shorter reads noise as trend. */
  demandHistoryDays: 90,
  /** "Nothing has left in this long" is what makes stock dead rather than slow. */
  deadStockDays: 90,
  /** A purchase order is late the day after it was due; no grace. */
  vendorDelayDays: 0,
  /** Negative on-hand is a present-tense fact; there is no window to average. */
  negativeStockDays: 0,
  /** This week's adjustments against the three weeks before it. */
  adjustmentRecentDays: 7,
  adjustmentBaselineDays: 30,
  /** Two weeks of shelf life is the point at which a decision is still possible. */
  expiryHorizonDays: 14,
  /** Inside a week, it is an escalation rather than a warning. */
  expiryUrgentDays: 7,
} as const;

export interface InvAnomalyDetector {
  type: InvAnomalyType;
  label: string;
  /**
   * The arithmetic, in words, exactly as the query performs it. Server-authored
   * and static — a model never writes this, and it is never assembled from a
   * row, so it cannot carry tenant text into a caption.
   */
  formula: string;
  /** What "recently" means for this detector, in days. `null` = point-in-time. */
  windowDays: number | null;
  /** How the window is stated to a reader. */
  windowLabel: string;
  /** What raises severity from medium to high. */
  severityRule: string;
  /** The kinds of record a finding of this type points at. */
  evidenceKinds: readonly InvEvidenceKind[];
  /** The deterministic screen that recomputes this. Never model output. */
  href: string;
  /**
   * Whether a finding of this type can be attributed to one warehouse.
   *
   * `false` means the arithmetic aggregates across every site the organisation
   * has — a demand series summed org-wide does not belong to a warehouse, and
   * pretending otherwise would attach a figure to a site it was not computed
   * for. Findings with no site are org-wide information and are shown only to a
   * caller whose own scope is org-wide.
   */
  siteAttributable: boolean;
}

const DETECTORS: Readonly<Record<InvAnomalyType, InvAnomalyDetector>> = {
  stockout_risk: {
    type: "stockout_risk",
    label: "Stockout risk",
    formula:
      "available quantity (on hand − committed − blocked − quality hold − outbound picks, excluding goods in transit) is below mean weekly sales",
    windowDays: ANOMALY_WINDOWS.demandHistoryDays,
    windowLabel: `mean weekly sales over the last ${ANOMALY_WINDOWS.demandHistoryDays} days`,
    severityRule: "high when available quantity is already negative, otherwise medium",
    evidenceKinds: ["product_variant"],
    href: "/inventory/replenishment",
    siteAttributable: false,
  },
  dead_stock: {
    type: "dead_stock",
    label: "Dead stock",
    formula:
      "on-hand quantity is positive and no SALE or TRANSFER_OUT movement exists in the window",
    windowDays: ANOMALY_WINDOWS.deadStockDays,
    windowLabel: `no outbound movement in ${ANOMALY_WINDOWS.deadStockDays} days`,
    severityRule: "always medium — dead stock is a cost, not an incident",
    evidenceKinds: ["product_variant"],
    href: "/inventory/reports/slow-moving",
    siteAttributable: false,
  },
  vendor_delay: {
    type: "vendor_delay",
    label: "Vendor delay",
    formula:
      "purchase order is SENT or PARTIAL and its expected delivery date is in the past",
    windowDays: ANOMALY_WINDOWS.vendorDelayDays,
    windowLabel: "as of today",
    severityRule: "high beyond 7 days late, otherwise medium",
    evidenceKinds: ["purchase_order", "vendor", "warehouse"],
    href: "/inventory/purchase-orders",
    siteAttributable: true,
  },
  negative_stock: {
    type: "negative_stock",
    label: "Negative stock",
    formula: "summed on-hand quantity for the SKU is below zero",
    windowDays: ANOMALY_WINDOWS.negativeStockDays,
    windowLabel: "current position",
    severityRule: "always high — the ledger disagrees with the shelf",
    evidenceKinds: ["product_variant"],
    href: "/inventory/stock",
    siteAttributable: false,
  },
  unusual_adjustments: {
    type: "unusual_adjustments",
    label: "Unusual adjustments",
    formula:
      "adjustment count in the recent window exceeds three times the weekly average of the preceding baseline",
    windowDays: ANOMALY_WINDOWS.adjustmentRecentDays,
    windowLabel: `last ${ANOMALY_WINDOWS.adjustmentRecentDays} days against the preceding ${ANOMALY_WINDOWS.adjustmentBaselineDays - ANOMALY_WINDOWS.adjustmentRecentDays} days`,
    severityRule: "always medium — a spike is a question, not yet a finding",
    evidenceKinds: ["product_variant"],
    href: "/inventory/stock/adjustments",
    siteAttributable: false,
  },
  expiry_risk: {
    type: "expiry_risk",
    label: "Expiring stock",
    formula: "lot has on-hand quantity above zero and its expiry date falls inside the horizon",
    windowDays: ANOMALY_WINDOWS.expiryHorizonDays,
    windowLabel: `expiring within ${ANOMALY_WINDOWS.expiryHorizonDays} days`,
    severityRule: `high within ${ANOMALY_WINDOWS.expiryUrgentDays} days, otherwise medium`,
    evidenceKinds: ["lot", "product_variant", "warehouse"],
    href: "/inventory/reports/expiry",
    siteAttributable: true,
  },
};

/**
 * Every type has a definition, checked at module load. A type added to the enum
 * without deciding its formula and window would otherwise render as `undefined`
 * in a caption an operator is asked to act on.
 */
const missing = INV_ANOMALY_TYPES.filter((type) => !DETECTORS[type]);
if (missing.length > 0) {
  throw new Error(`inv-anomaly-detectors: no definition for ${missing.join(", ")}`);
}

export const INV_ANOMALY_DETECTORS = DETECTORS;

export function isAnomalyType(value: string): value is InvAnomalyType {
  return (INV_ANOMALY_TYPES as readonly string[]).includes(value);
}

/**
 * The detector behind a stored finding, or `null` for a type this build no
 * longer knows.
 *
 * `null` rather than a throw: a row written by an older build must still be
 * listable and dismissible. What it must not do is borrow another detector's
 * formula, so the caption degrades to "no longer computed by this build" rather
 * than to a plausible sentence about the wrong arithmetic.
 */
export function detectorFor(type: string): InvAnomalyDetector | null {
  return isAnomalyType(type) ? DETECTORS[type] : null;
}
