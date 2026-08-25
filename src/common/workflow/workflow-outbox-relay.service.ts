import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, asc, eq, gt } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { outboxEvents } from "../../db/schema";
import { reportError } from "../observability";
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

  /** Advances only past events actually considered, so nothing is skipped. */
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

    for (const event of events) {
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

      this.cursor = event.outboxEventId;
    }

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
