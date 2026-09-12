import type { SweepStaleness } from "./sign-sweep-staleness";

export const SWEEP_PREVIEW_LIMIT = 100;

export interface SweepPreviewEntry {
  envelopeId: number;
  title: string;
  affected: number;
}

export interface SweepPreview {
  sweep: "reminder" | "expiration";
  envelopes: number;
  affected: number;
  entries: SweepPreviewEntry[];
  truncated: boolean;
}

export interface SweepAllResult {
  sweep: "reminder" | "expiration";
  dryRun: boolean;
  organizations: number;
  succeeded: number;
  failed: number;
  affected: number;
}

export interface SignSweepRunSummary {
  sweep: "reminder" | "expiration";
  ranAt: string | null;
  affected: number;
  error: string | null;
  neverRun: boolean;
  staleness: SweepStaleness;
  healthy: boolean;
  expectedWithinHours: number;
}
