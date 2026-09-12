export const GOAL_PAGE = 200;
export const REVIEW_PAGE = 100;
export const ASSET_PAGE = 200;
/**
 * The per-tick budget. These sweeps emit an automation event and mark nothing, so
 * without a resumable cursor the same first page matched every tick and everything
 * past it was never emitted at all. The budget keeps one tick bounded; the cursor
 * makes the coverage complete across ticks.
 */
export const MAX_PAGES_PER_TICK = 5;

export interface EmitSweepResult {
  swept: number;
  /** The per-tick budget was spent with rows still eligible; the next tick resumes. */
  truncated: boolean;
}

export interface SweepResult {
  orgId: string;
  sweep: string;
  ok: boolean;
  error?: string;
}

export interface RunAllResult {
  results: SweepResult[];
  orgsProcessed: number;
  succeeded: number;
  failed: number;
}
