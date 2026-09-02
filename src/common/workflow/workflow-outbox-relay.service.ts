import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, asc, eq, gt } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { outboxEvents } from "../../db/schema";
import { randomUUID } from "node:crypto";
import { reportError, runWithObservabilityContext } from "../observability";
import { currentRelease } from "../observability/release";
import { PROCESS_CELL_ID } from "../cell-resources/cell-id";
import { WorkflowRegistry } from "./workflow-registry";
import { WorkflowRunnerService } from "./workflow-runner.service";

export const RELAY_BATCH_SIZE = 50;

export interface RelayResult {
  scanned: number;
  started: number;
}

/**
 * Turns committed outbox events into workflow runs.
 *
 * The transactional guarantee comes for free and is the reason this reads the
 * outbox rather than being called inline: an event row is written in the same
 * transaction as the change that produced it, so a transaction that rolls back
 * leaves no event, and therefore starts no run. Work is never scheduled for a
 * change that did not happen.
 *
 * Delivery is at-least-once, so the same event may be seen twice; `startRun`
 * keys on the event id and returns the existing run instead of starting a
 * second.
 */
@Injectable()
export class WorkflowOutboxRelayService {
  private readonly logger = new Logger(WorkflowOutboxRelayService.name);

  /**
   * How far behind the highest event seen the cursor is allowed to settle.
   *
   * `outbox_event_id` comes from an identity sequence, and a sequence hands out
   * its numbers when a transaction *asks*, not when it commits. So ids become
   * visible in commit order, not in numeric order: transaction A takes 100 and B
   * takes 101, B commits first, and a relay pass sees 101 while 100 is still
   * invisible. A cursor that advanced straight to 101 would then query
   * `> 101` forever and **event 100 would never start its workflow** — not
   * delayed, never. For the life of the process.
   *
   * Holding the cursor this far back turns that permanent skip into a bounded
   * re-read. It is safe to re-read because `startRun` keys on
   * `causationEventId` and returns the existing run rather than starting a
   * second, which the class already relies on for at-least-once delivery — and
   * because the cursor lives in memory, so every restart already re-reads from
   * zero. Re-reading is the designed-for path, not an exception to it.
   *
   * This is a mitigation sized to how long a writing transaction can plausibly
   * stay open, not a proof. The complete fix is the claim `outbox-publisher`
   * already uses — a persisted delivery state with a lease and
   * `FOR UPDATE SKIP LOCKED` — which needs its own state column here, since the
   * publisher and the relay are two independent consumers of one stream and
   * cannot share one.
   */
  private static readonly CURSOR_LAG = 1000;

  /** Trails the highest event seen by `CURSOR_LAG`, so a late commit is not skipped. */
  private cursor = 0;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly registry: WorkflowRegistry,
    private readonly runner: WorkflowRunnerService,
  ) {}

  async relay(limit: number = RELAY_BATCH_SIZE): Promise<RelayResult> {
    const events = await this.db
      .select({
        outboxEventId: outboxEvents.outboxEventId,
        eventId: outboxEvents.eventId,
        organizationId: outboxEvents.organizationId,
        eventType: outboxEvents.eventType,
        payload: outboxEvents.payload,
        correlationId: outboxEvents.correlationId,
      })
      .from(outboxEvents)
      .where(
        and(
          gt(outboxEvents.outboxEventId, this.cursor),
          eq(outboxEvents.lifecycleState, "ACTIVE"),
        ),
      )
      .orderBy(asc(outboxEvents.outboxEventId))
      .limit(limit);

    let started = 0;
    let highest = 0;

    for (const event of events) {
      /**
       * The relay runs on a timer, in a process that did not serve the request
       * that produced the event, so there is no scope to inherit and nothing may
       * be borrowed from whatever triggered the tick. The context is stated from
       * the row: the producer's correlation id joins the workflow run's log lines
       * back to the request, and the organisation is named rather than assumed.
       */
      await runWithObservabilityContext(
        {
          correlationId: event.correlationId ?? randomUUID(),
          orgId: event.organizationId,
          route: `workflow-relay:${event.eventType}`,
          cellId: PROCESS_CELL_ID,
          release: currentRelease(),
        },
        async () => {
          for (const definition of this.registry.triggeredBy(event.eventType)) {
            try {
              const runId = await this.runner.start({
                organizationId: event.organizationId,
                workflowName: definition.name,
                input: (event.payload ?? {}) as Record<string, unknown>,
                correlationId: event.correlationId,
                causationEventId: event.eventId,
                maxAttempts: definition.maxAttempts,
              });
              if (runId) started += 1;
            } catch (error) {
              // One malformed event must not stall the relay for every other tenant.
              reportError(error, {
                phase: "workflow-relay",
                eventType: event.eventType,
                orgId: event.organizationId,
              });
              this.logger.error(
                `Relay failed for ${event.eventType} → ${definition.name}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
          }
        },
      );

      highest = Math.max(highest, event.outboxEventId);
    }

    if (highest > 0)
      this.cursor = Math.max(this.cursor, highest - WorkflowOutboxRelayService.CURSOR_LAG);

    if (started > 0) this.logger.log(`Relay started ${String(started)} workflow run(s)`);

    return { scanned: events.length, started };
  }

  /**
   * Where the relay has read up to.
   *
   * In-process, so a restart re-reads recent events. That is safe because
   * starting a run is keyed on the event id, and it is preferable to persisting
   * a cursor that could advance past an event whose run failed to start.
   */
  get position(): number {
    return this.cursor;
  }

  resetPosition(to = 0): void {
    this.cursor = to;
  }
}
