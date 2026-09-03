import { Logger } from "@nestjs/common";

const DEADLINE = Symbol("home-section-deadline");

/**
 * Ceiling on how long one Home section may hold the whole aggregate.
 *
 * Measured on scratch_perf_seed at head as `streamline_app` with the tenant GUC
 * set, across the 89.93% and 0.18% tenants: every Home source plans in 0.6-0.7 ms
 * over 239-799 buffers and executes in 1.2-2.3 ms, except the unread-notification
 * count, which plans in 31.7-50.4 ms over 12,063 buffers because `notifications`
 * has 49 partitions and `prepare: false` rebuilds that plan on every request.
 * The slowest measured source is therefore ~52 ms; this ceiling is ~48x that, so
 * it cannot fire on a healthy read and only bites a source that has stalled.
 */
export const HOME_SECTION_DEADLINE_MS = 2_500;

interface SettleSectionOptions<T> {
  readonly name: string;
  readonly run: () => Promise<T>;
  readonly fallback: T;
  readonly logger: Logger;
  readonly context: string;
  readonly onDegraded?: (name: string) => void;
  readonly deadlineMs?: number;
}

/**
 * Runs one Home section and always resolves.
 *
 * A rejection degrades that section alone, and so does exceeding the deadline:
 * the aggregate hands back every section that did answer rather than waiting on
 * the one that did not, which is the difference between "one section is missing"
 * and "Home is blank". The abandoned promise keeps a rejection handler so a late
 * failure never surfaces as an unhandled rejection.
 */
export async function settleSection<T>({
  name,
  run,
  fallback,
  logger,
  context,
  onDegraded,
  deadlineMs = HOME_SECTION_DEADLINE_MS,
}: SettleSectionOptions<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const degrade = (reason: string, detail?: string): T => {
    onDegraded?.(name);
    logger.error(`Home section "${name}" ${reason} for ${context}`, detail);
    return fallback;
  };

  try {
    const work = Promise.resolve().then(run);
    work.catch(() => undefined);

    const deadline = new Promise<typeof DEADLINE>((resolve) => {
      timer = setTimeout(() => resolve(DEADLINE), deadlineMs);
      timer.unref?.();
    });

    const outcome = await Promise.race([work, deadline]);
    if (outcome === DEADLINE) return degrade(`exceeded ${deadlineMs}ms and was abandoned`);
    return outcome;
  } catch (error: unknown) {
    return degrade("failed", error instanceof Error ? error.stack : String(error));
  } finally {
    if (timer) clearTimeout(timer);
  }
}
