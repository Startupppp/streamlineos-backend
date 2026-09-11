import { randomUUID } from "node:crypto";
import { PROCESS_CELL_ID } from "../cell-resources/cell-id";
import { currentRelease } from "./release";
import { getObservabilityContext, runWithObservabilityContext } from "./observability-context";
import { withSpan } from "./tracing";

/**
 * The two halves of an asynchronous hop.
 *
 * A hop is any point where the work outlives the request that asked for it: an
 * outbox row, a workflow run, a queued job. It always has a producer that writes
 * a row and a consumer that reads it back, usually in a different process, and
 * the correlation id is the only thing that can carry the originating intent
 * across the gap — the async context cannot, because there is nothing to inherit
 * from by the time the consumer runs.
 *
 * Getting one half right is worth nothing. A producer that persists the id and a
 * consumer that mints a fresh one produces two perfectly structured traces of the
 * same intent that can never be joined, which reads as correct instrumentation
 * right up until somebody tries to answer "what did that button press actually
 * do". Both halves live here so a new hop has one obvious thing to call twice
 * rather than two conventions to rediscover.
 */

/**
 * The id a producer should persist alongside the row it is writing.
 *
 * `null` rather than a fresh id when there is no ambient context: minting one at
 * write time would stamp the row with an id no log line anywhere else carries,
 * which looks like a correlation and is not one. A consumer that finds `null`
 * knows the row genuinely has no origin to join back to.
 */
export function correlationIdToPersist(explicit?: string | null): string | null {
  if (explicit !== undefined && explicit !== null) return explicit;
  return getObservabilityContext()?.correlationId ?? null;
}

export interface AsyncHop {
  /** What the producer persisted on the row. A legacy row may carry nothing. */
  readonly correlationId: string | null | undefined;
  /** Stated from the row, never inherited — a worker has no tenant to borrow. */
  readonly orgId?: string | undefined;
  /** Names the consumer on every line it emits, e.g. `outbox:deal.closed`. */
  readonly route: string;
  /** Opened around the work so the timing joins the same trace. */
  readonly span?:
    | {
        readonly name: string;
        readonly attributes?: Readonly<Record<string, string | number | boolean>>;
      }
    | undefined;
}

/**
 * Runs the consumer half inside the originating intent.
 *
 * Deliberately `runWithObservabilityContext` and not `bindObservabilityContext`:
 * there is nothing ambient worth keeping. A consumer runs on a timer, and
 * inheriting the tick's context would attribute the work to whatever triggered
 * the sweep — which is precisely the unrelated trace id this exists to prevent.
 *
 * A row with no persisted id gets a fresh one rather than none, so the
 * consumer's own lines still group together. They simply do not join back to a
 * request, which is the honest report of a row written before its producer
 * carried the id.
 */
export function runInRestoredContext<T>(hop: AsyncHop, fn: () => Promise<T>): Promise<T> {
  return runWithObservabilityContext(
    {
      correlationId: hop.correlationId ?? randomUUID(),
      ...(hop.orgId ? { orgId: hop.orgId } : {}),
      route: hop.route,
      cellId: PROCESS_CELL_ID,
      release: currentRelease(),
    },
    () => {
      if (!hop.span) return fn();
      return withSpan(
        hop.span.name,
        fn,
        hop.span.attributes ? { attributes: hop.span.attributes } : {},
      );
    },
  );
}
