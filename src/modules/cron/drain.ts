import { Redis } from "@upstash/redis";
import { logger } from "../../common/logger/logger.service";

/**
 * What one page of a sweep did.
 *
 * `selected` and `processed` are separate on purpose. A page that selected a full page
 * and processed none of it is a stall — the rows matched the predicate and nothing
 * changed, so the next pass re-selects exactly the same rows — and a loop that counted
 * only selected rows would spin on it until its cap. A loop that counted only processed
 * rows would stop early whenever a page contained rows it legitimately skipped.
 */
export interface PageOutcome {
  selected: number;
  processed: number;
}

export interface DrainResult {
  processed: number;
  scanned: number;
  pages: number;
  /** The cap was hit, or the drain stalled, with rows still eligible. */
  truncated: boolean;
  /** A full page produced no progress: the remaining rows can never be processed. */
  stalled: boolean;
}

/**
 * Drains a predicate page by page until a short page proves the backlog is exhausted.
 *
 * A bare `.limit(n)` on growing work is the defect this replaces: one page per tick
 * reported success having processed the first page and left the rest, for ever.
 */
export async function drainPages(
  pageSize: number,
  maxPages: number,
  batch: (page: number) => Promise<PageOutcome>,
): Promise<DrainResult> {
  const result: DrainResult = {
    processed: 0,
    scanned: 0,
    pages: 0,
    truncated: false,
    stalled: false,
  };
  for (let page = 0; page < maxPages; page++) {
    const outcome = await batch(page);
    result.pages += 1;
    result.scanned += outcome.selected;
    result.processed += outcome.processed;
    if (outcome.selected < pageSize) return result;
    if (outcome.processed === 0) {
      result.stalled = true;
      result.truncated = true;
      return result;
    }
  }
  result.truncated = true;
  return result;
}

const CURSOR_TTL_SECONDS = 7 * 24 * 3600;

/**
 * A per-tenant position that survives across ticks.
 *
 * The sweeps that emit an automation event and mark nothing have no column to resume
 * from: the same first N rows matched every tick and everything past N was never
 * reached at all. Adding a `last_notified` column needs a migration; a Redis cursor
 * does not, and `CronAiUsageRetentionService` already resumes this way. Redis being
 * absent degrades to the old behaviour rather than failing the sweep.
 */
export class RotatingCursor {
  constructor(
    private readonly redis: Redis | null,
    private readonly namespace: string,
  ) {}

  private key(scope: string): string {
    return `cursor:${this.namespace}:${scope}`;
  }

  async read(scope: string): Promise<number> {
    if (!this.redis) return 0;
    try {
      const raw = await this.redis.get(this.key(scope));
      const parsed = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    } catch (err: unknown) {
      logger.warn(`[${this.namespace}] cursor read failed for ${scope}; restarting from zero`, {
        cause: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }
  }

  async write(scope: string, value: number): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.set(this.key(scope), value, { ex: CURSOR_TTL_SECONDS });
    } catch (err: unknown) {
      logger.warn(`[${this.namespace}] cursor write failed for ${scope}`, {
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async reset(scope: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.del(this.key(scope));
    } catch (err: unknown) {
      logger.warn(`[${this.namespace}] cursor reset failed for ${scope}`, {
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export interface RotatingDrainResult {
  emitted: number;
  pages: number;
  /** The per-tick budget was spent with rows still eligible; the cursor is kept. */
  truncated: boolean;
}

/**
 * Emits for every eligible row across ticks, on a bounded per-tick budget.
 *
 * The cursor is kept when the budget runs out, so the next tick starts where this one
 * stopped, and cleared once a short page proves the pass is complete. That turns
 * "the first 200 for ever and the rest never" into full coverage without either an
 * unbounded per-tick burst or a schema change.
 */
export async function drainWithCursor<T extends { id: number }>(
  cursor: RotatingCursor,
  scope: string,
  pageSize: number,
  maxPages: number,
  page: (after: number, limit: number) => Promise<T[]>,
  handle: (rows: T[]) => Promise<void>,
): Promise<RotatingDrainResult> {
  const result: RotatingDrainResult = { emitted: 0, pages: 0, truncated: false };
  let after = await cursor.read(scope);

  for (let i = 0; i < maxPages; i++) {
    const rows = await page(after, pageSize);
    result.pages += 1;
    if (rows.length === 0) {
      await cursor.reset(scope);
      return result;
    }
    await handle(rows);
    result.emitted += rows.length;
    const last = rows[rows.length - 1];
    if (!last || last.id === after) {
      await cursor.reset(scope);
      return result;
    }
    after = last.id;
    if (rows.length < pageSize) {
      await cursor.reset(scope);
      return result;
    }
    await cursor.write(scope, after);
  }

  result.truncated = true;
  return result;
}
