import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { organizations, outboxEvents } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { APP_CONFIG } from "../../config/config.module";
import type { AppConfig } from "../../config/env.validation";
import {
  nextRetryDelayWithJitterMs,
  shouldDeadLetter,
  shouldSuppressForLifecycle,
} from "./outbox-envelope";
import { OutboxConsumerRegistry, type OutboxEventRow } from "./outbox-consumer.registry";
import { runInNewTenantTransaction } from "../tenant/run-in-tenant-transaction";
import { OutboxBatchClaimer } from "./outbox-claim";
import {
  OUTBOX_DELIVERY_DEADLINE_MS,
  withDeliveryDeadline,
} from "./outbox-delivery-deadline";
import { OutboxReportService } from "./outbox-report.service";
import { runInRestoredContext } from "../observability/async-hop";
import { scrubBindParameters, truncateForLog } from "../observability/redact";
import type { OutboxFlushResult, OutboxMetrics, OutboxOrganizationReport, OutboxReport } from "./outbox-publisher.types";

export type { OutboxFlushResult, OutboxMetrics, OutboxOrganizationReport, OutboxReport };

@Injectable()
export class OutboxPublisherService {
  private readonly logger = new Logger(OutboxPublisherService.name);
  private noBrokerWarned = false;
  private readonly claimer: OutboxBatchClaimer;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly registry: OutboxConsumerRegistry,
    private readonly reportService: OutboxReportService,
  ) {
    this.claimer = new OutboxBatchClaimer(db);
  }

  private isDispatchConfigured(): boolean {
    return this.config.OUTBOX_DISPATCH_ENABLED !== "false";
  }

  async flush(): Promise<OutboxFlushResult> {
    if (!this.isDispatchConfigured()) {
      if (!this.noBrokerWarned) {
        this.logger.warn(
          "OutboxPublisher: no dispatch target is configured — flush is a no-op; events remain " +
            "PENDING and will be retried when a broker is wired. Set OUTBOX_DISPATCH_ENABLED=true " +
            "and register consumers to enable real dispatch. (Further warnings suppressed.)",
        );
        this.noBrokerWarned = true;
      }
      return { claimed: 0, delivered: 0, suppressed: 0, retried: 0, dead: 0, fenced: 0 };
    }
    const claimed = await this.claimer.claim();
    let delivered = 0;
    let suppressed = 0;
    let retried = 0;
    let dead = 0;
    let fenced = 0;

    for (const event of claimed) {
      const outcome = await this.inEventContext(event, () => this.processEvent(event));
      if (outcome === "DELIVERED") delivered++;
      else if (outcome === "SUPPRESSED") suppressed++;
      else if (outcome === "DEAD") dead++;
      else if (outcome === "RETRY") retried++;
      else fenced++;
    }

    return { claimed: claimed.length, delivered, suppressed, retried, dead, fenced };
  }

  /**
   * Delivery runs long after the request that produced the event, in a process
   * that may not have served it at all, so there is no ambient context to
   * inherit and nothing may be borrowed from one. The context is rebuilt from
   * the row: the producer's correlation id becomes the join key, and the
   * organisation is stated explicitly rather than assumed.
   *
   * A legacy row written before `OutboxWriter` defaulted the column has no
   * correlation id. It gets a fresh one instead of none, so the delivery's own
   * log lines still group together — they simply do not join back to a request.
   */
  private inEventContext<T>(event: OutboxEventRow, fn: () => Promise<T>): Promise<T> {
    return runInRestoredContext(
      {
        correlationId: event.correlationId,
        orgId: event.organizationId,
        route: `outbox:${event.eventType}`,
        span: {
          name: "outbox.deliver",
          attributes: {
            "outbox.event_type": event.eventType,
            "outbox.attempt": event.retryCount + 1,
          },
        },
      },
      fn,
    );
  }

  private async processEvent(
    event: OutboxEventRow,
  ): Promise<"DELIVERED" | "SUPPRESSED" | "DEAD" | "RETRY" | "FENCED"> {
    try {
      const lifecycle = await this.readOrgLifecycle(event.organizationId);
      if (!lifecycle.found || shouldSuppressForLifecycle(lifecycle.status)) {
        return (await this.mark(event, "SUPPRESSED")) ? "SUPPRESSED" : "FENCED";
      }

      await this.deliver(event);
      return (await this.mark(event, "DELIVERED", { publishedAt: new Date() }))
        ? "DELIVERED"
        : "FENCED";
    } catch (error: unknown) {
      return this.handleFailure(event, error);
    }
  }

  metrics(): Promise<OutboxMetrics> {
    return this.reportService.metrics();
  }

  reportByOrganization(): Promise<OutboxOrganizationReport[]> {
    return this.reportService.reportByOrganization();
  }

  report(): Promise<OutboxReport> {
    return this.reportService.report();
  }

  private async readOrgLifecycle(
    organizationId: string,
  ): Promise<{ found: boolean; status: string }> {
    return runInNewTenantTransaction(this.db, organizationId, async (tx) => {
      const rows = await tx
        .select({ status: organizations.status })
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .limit(1);
      const row = rows[0];
      if (!row) return { found: false, status: "PURGED" };
      return { found: true, status: row.status ?? "ACTIVE" };
    });
  }

  private async deliver(event: OutboxEventRow): Promise<void> {
    const consumers = this.registry.getAll(event.eventType);
    if (consumers.length === 0) {
      throw new Error(
        `no dispatch handler for event type '${event.eventType}' — register a consumer via OutboxConsumerRegistry`,
      );
    }
    /**
     * Each consumer gets its own tenant transaction rather than sharing one: a
     * rollback in the second must not undo the first's work, and one long
     * consumer must not hold a pooled connection open for the others.
     *
     * The transaction is what gives the consumer its tenant GUC — `this.db` in
     * every consumer resolves to this `tx` through the ambient tenant context,
     * and `app.current_org_id()` raises with no GUC set — so it cannot simply be
     * dropped, however long a consumer's provider call takes. What can be fixed
     * is the "however long": see `withDeliveryDeadline` for why an unbounded
     * `handle()` here re-POSTs a stuck webhook forever. The deadline is per
     * consumer, so one stuck consumer cannot spend the others' budget.
     */
    for (const consumer of consumers) {
      await runInNewTenantTransaction(this.db, event.organizationId, async () => {
        await withDeliveryDeadline(
          event.eventType,
          OUTBOX_DELIVERY_DEADLINE_MS,
          () => consumer.handle(event),
          (cause: unknown) => {
            this.logger.error(
              `outbox ${event.eventId} (${event.eventType}) was abandoned at its delivery ` +
                `deadline and then failed on a rolled-back transaction: ` +
                `${truncateForLog(scrubBindParameters(cause instanceof Error ? cause.message : String(cause)))}`,
            );
          },
        );
      });
    }
  }

  private async handleFailure(
    event: OutboxEventRow,
    error: unknown,
  ): Promise<"DEAD" | "RETRY" | "FENCED"> {
    // `last_error` is read back by the dead-outbox alert and printed into an
    // operator's terminal, so it is a log destination in every sense that
    // matters. A Drizzle failure's message carries the statement's bind values;
    // storing them unscrubbed would put tenant data into that output.
    const message = truncateForLog(
      scrubBindParameters(error instanceof Error ? error.message : String(error)),
    );
    const retryCount = event.retryCount + 1;

    if (shouldDeadLetter(retryCount)) {
      const updated = await runInNewTenantTransaction(this.db, event.organizationId, async (tx) => {
        const query = tx
          .update(outboxEvents)
          .set({
            deliveryState: "DEAD",
            retryCount,
            lastError: message,
            deadLetteredAt: new Date(),
          })
          .where(and(
            eq(outboxEvents.outboxEventId, event.outboxEventId),
            eq(outboxEvents.deliveryState, "IN_FLIGHT"),
            event.leaseExpiresAt === null
              ? isNull(outboxEvents.leaseExpiresAt)
              : eq(outboxEvents.leaseExpiresAt, event.leaseExpiresAt),
          ));
        return typeof (query as { returning?: unknown } | undefined)?.returning === "function"
          ? (query as { returning: (fields: unknown) => unknown }).returning({ outboxEventId: outboxEvents.outboxEventId })
          : query;
      });
      if (Array.isArray(updated) && updated.length === 0) return "FENCED";
      this.logger.error(
        `outbox ${event.eventId} dead-lettered after ${retryCount} attempts: ${message}`,
      );
      return "DEAD";
    }

    const updated = await runInNewTenantTransaction(this.db, event.organizationId, async (tx) => {
      const query = tx
        .update(outboxEvents)
        .set({
          deliveryState: "PENDING",
          retryCount,
          lastError: message,
          leaseExpiresAt: new Date(Date.now() + nextRetryDelayWithJitterMs(retryCount)),
        })
        .where(and(
          eq(outboxEvents.outboxEventId, event.outboxEventId),
          eq(outboxEvents.deliveryState, "IN_FLIGHT"),
          event.leaseExpiresAt === null
            ? isNull(outboxEvents.leaseExpiresAt)
            : eq(outboxEvents.leaseExpiresAt, event.leaseExpiresAt),
        ));
      return typeof (query as { returning?: unknown } | undefined)?.returning === "function"
        ? (query as { returning: (fields: unknown) => unknown }).returning({ outboxEventId: outboxEvents.outboxEventId })
        : query;
    });
    if (Array.isArray(updated) && updated.length === 0) return "FENCED";
    return "RETRY";
  }

  private async mark(
    event: OutboxEventRow,
    deliveryState: "DELIVERED" | "SUPPRESSED",
    extra: { publishedAt?: Date } = {},
  ): Promise<boolean> {
    const updated = await runInNewTenantTransaction(this.db, event.organizationId, async (tx) => {
      const query = tx
        .update(outboxEvents)
        .set({ deliveryState, leaseExpiresAt: null, ...extra })
        .where(and(
          eq(outboxEvents.outboxEventId, event.outboxEventId),
          eq(outboxEvents.deliveryState, "IN_FLIGHT"),
          event.leaseExpiresAt === null
            ? isNull(outboxEvents.leaseExpiresAt)
            : eq(outboxEvents.leaseExpiresAt, event.leaseExpiresAt),
        ));
      return typeof (query as { returning?: unknown } | undefined)?.returning === "function"
        ? (query as { returning: (fields: unknown) => unknown }).returning({ outboxEventId: outboxEvents.outboxEventId })
        : query;
    });
    return !Array.isArray(updated) || updated.length > 0;
  }
}
