import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, asc, eq, gt } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { outboxEvents } from "../../db/schema";
import { reportError, runInRestoredContext } from "../observability";
import { forEachOrg } from "../tenant";
import { WorkflowRegistry } from "./workflow-registry";
import { WorkflowRunnerService } from "./workflow-runner.service";

export const RELAY_BATCH_SIZE = 50;

export interface RelayResult {
  scanned: number;
  started: number;
}

/** One outbox row, projected to what starting a run needs. */
interface RelayEvent {
  outboxEventId: number;
  eventId: string;
  organizationId: string;
  eventType: string;
  payload: unknown;
  correlationId: string | null;
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

  /**
   * Where the relay has read up to, **per organisation**.
   *
   * One shared cursor across every tenant was wrong twice over. It was denied
   * outright under RLS (see `relay`), and even as the owner it was lossy: the
   * ids come from one global sequence, so a busy tenant's events advance the
   * cursor past a quiet tenant's lower-numbered ones, which are then never read.
   * A quiet tenant's workflows simply never started, in proportion to how noisy
   * its neighbours were.
   *
   * Keyed by organisation id, each entry still trails that organisation's
   * highest seen event by `CURSOR_LAG`.
   */
  private readonly cursors = new Map<string, number>();

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly registry: WorkflowRegistry,
    private readonly runner: WorkflowRunnerService,
  ) {}

  /**
   * Reads each organisation's outbox inside that organisation's transaction.
   *
   * The previous form issued one cross-tenant select with no ambient tenant
   * context. `outbox_events` carries `organization_id = app.current_org_id()`
   * and that function RAISEs when the GUC is unset, so as the application role
   * the statement threw rather than returning nothing — and because
   * `CronWorkflowService.tick()` calls this before `drain()` and does not guard
   * it, the throw took out the whole tick. `POST /cron/workflow-tick` answered
   * 500 and *nothing durable advanced*. As the database owner it appeared to
   * work, because BYPASSRLS makes the policy inert; that is why it survived CI.
   *
   * `forEachOrg` is the pattern the sibling outbox publisher already uses for
   * the identical problem: enumerate organisations (which carry no policy of
   * their own), then do the tenant-scoped read inside each one's transaction.
   * One organisation failing is isolated there and does not abort the sweep, so
   * a single malformed tenant can no longer stop every other tenant's workflows.
   *
   * Events are collected under the sweep and the runs are started after it, so
   * no tenant transaction stays open across the work of starting runs.
   */
  async relay(limit: number = RELAY_BATCH_SIZE): Promise<RelayResult> {
    const events: RelayEvent[] = [];

    await forEachOrg(
      this.db,
      "workflow-outbox-relay",
      async (tx, orgId) => {
        const remaining = limit - events.length;
        if (remaining <= 0) return;

        const rows = await tx
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
              eq(outboxEvents.organizationId, orgId),
              gt(outboxEvents.outboxEventId, this.cursors.get(orgId) ?? 0),
              eq(outboxEvents.lifecycleState, "ACTIVE"),
            ),
          )
          .orderBy(asc(outboxEvents.outboxEventId))
          .limit(remaining);

        events.push(...rows);
      },
      "read",
    );

    let started = 0;
    const highestPerOrg = new Map<string, number>();

    for (const event of events) {
      /**
       * The relay runs on a timer, in a process that did not serve the request
       * that produced the event, so there is no scope to inherit and nothing may
       * be borrowed from whatever triggered the tick. The context is stated from
       * the row: the producer's correlation id joins the workflow run's log lines
       * back to the request, and the organisation is named rather than assumed.
       */
      await runInRestoredContext(
        {
          correlationId: event.correlationId,
          orgId: event.organizationId,
          route: `workflow-relay:${event.eventType}`,
          span: { name: "workflow.relay", attributes: { "outbox.event_type": event.eventType } },
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

      highestPerOrg.set(
        event.organizationId,
        Math.max(highestPerOrg.get(event.organizationId) ?? 0, event.outboxEventId),
      );
    }

    for (const [orgId, highest] of highestPerOrg)
      this.cursors.set(
        orgId,
        Math.max(
          this.cursors.get(orgId) ?? 0,
          highest - WorkflowOutboxRelayService.CURSOR_LAG,
        ),
      );

    if (started > 0) this.logger.log(`Relay started ${String(started)} workflow run(s)`);

    return { scanned: events.length, started };
  }

  /**
   * Where the relay has read up to for one organisation.
   *
   * In-process, so a restart re-reads recent events. That is safe because
   * starting a run is keyed on the event id, and it is preferable to persisting
   * a cursor that could advance past an event whose run failed to start.
   */
  positionFor(organizationId: string): number {
    return this.cursors.get(organizationId) ?? 0;
  }

  /**
   * The furthest any organisation has been read to.
   *
   * Kept because callers used it as a single number, but it is a summary of many
   * cursors now and no longer identifies a position the relay would resume from.
   */
  get position(): number {
    let furthest = 0;
    for (const cursor of this.cursors.values()) furthest = Math.max(furthest, cursor);
    return furthest;
  }

  /** Resets every organisation's cursor, or one organisation's when named. */
  resetPosition(to = 0, organizationId?: string): void {
    if (organizationId === undefined) {
      this.cursors.clear();
      if (to !== 0) throw new Error("resetPosition: a non-zero reset must name an organisation");
      return;
    }
    this.cursors.set(organizationId, to);
  }
}
