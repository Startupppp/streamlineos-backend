import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { organizations, outboxEvents } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { APP_CONFIG } from "../../config/config.module";
import type { AppConfig } from "../../config/env.validation";
import {
  nextRetryDelayMs,
  shouldDeadLetter,
  shouldSuppressForLifecycle,
} from "./outbox-envelope";
import { OutboxConsumerRegistry, type OutboxEventRow } from "./outbox-consumer.registry";
import { runInNewTenantTransaction } from "../tenant/run-in-tenant-transaction";
import { forEachOrg } from "../tenant";

const BATCH_SIZE = 50;
const LEASE_MS = 30_000;

export interface OutboxFlushResult {
  claimed: number;
  delivered: number;
  suppressed: number;
  retried: number;
  dead: number;
  fenced: number;
}

export interface OutboxMetrics {
  pending: number;
  inFlight: number;
  dead: number;
  oldestPendingAt: Date | null;
}

export interface OutboxOrganizationReport {
  organizationId: string;
  totalRows: number;
  pending: number;
  inFlight: number;
  dead: number;
  oldestPendingAt: Date | null;
  oldestEventAt: Date | null;
  oldestEventAgeSeconds: number | null;
  distinctEventTypes: number;
}

export interface OutboxReport {
  generatedAt: string;
  organizations: number;
  succeeded: number;
  failed: number;
  reports: OutboxOrganizationReport[];
}

/**
 * Drains the transactional outbox: leases a batch of due PENDING events per organisation (each in
 * its own tenant transaction via forEachOrg — a cross-org sweep has no ambient GUC and is denied
 * 42501 by the outbox_events RLS policy), re-checks the owning organisation's lifecycle immediately
 * before delivery, then marks each DELIVERED or reschedules with bounded backoff / dead-letters past
 * the retry ceiling. An event type with no registered consumer is a configuration failure and takes
 * the same retry/dead-letter path as any other delivery failure; it is never silently discarded or
 * marked DELIVERED. Lifecycle suppression is reserved for organizations that no longer exist or
 * must not receive side effects. All state mutations run in their own per-org tenant transaction.
 */
@Injectable()
export class OutboxPublisherService {
  private readonly logger = new Logger(OutboxPublisherService.name);
  private noBrokerWarned = false;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly registry: OutboxConsumerRegistry,
  ) {}

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
    const claimed = await this.claimBatch();
    let delivered = 0;
    let suppressed = 0;
    let retried = 0;
    let dead = 0;
    let fenced = 0;

    for (const event of claimed) {
      try {
        const lifecycle = await this.readOrgLifecycle(event.organizationId);
        if (!lifecycle.found || shouldSuppressForLifecycle(lifecycle.status)) {
          if (await this.mark(event, "SUPPRESSED")) suppressed++;
          else fenced++;
          continue;
        }

        await this.deliver(event);
        if (await this.mark(event, "DELIVERED", { publishedAt: new Date() })) delivered++;
        else fenced++;
      } catch (error: unknown) {
        const outcome = await this.handleFailure(event, error);
        if (outcome === "DEAD") dead++;
        else if (outcome === "RETRY") retried++;
        else fenced++;
      }
    }

    return { claimed: claimed.length, delivered, suppressed, retried, dead, fenced };
  }

  async metrics(): Promise<OutboxMetrics> {
    const result: OutboxMetrics = { pending: 0, inFlight: 0, dead: 0, oldestPendingAt: null };
    await forEachOrg(this.db, "outbox-events-metrics", async (tx) => {
      const rows = await tx
        .select({
          totalRows: sql<number>`count(*)`,
          pending: sql<number>`count(*) filter (where ${outboxEvents.deliveryState} = 'PENDING')`,
          inFlight: sql<number>`count(*) filter (where ${outboxEvents.deliveryState} = 'IN_FLIGHT')`,
          dead: sql<number>`count(*) filter (where ${outboxEvents.deliveryState} = 'DEAD')`,
          oldestPendingAt: sql<Date | null>`min(${outboxEvents.createdAt}) filter (where ${outboxEvents.deliveryState} = 'PENDING')`,
          oldestEventAt: sql<Date | null>`min(${outboxEvents.createdAt})`,
        })
        .from(outboxEvents);
      const row = rows[0];
      if (!row) return;
      result.pending += Number(row.pending ?? 0);
      result.inFlight += Number(row.inFlight ?? 0);
      result.dead += Number(row.dead ?? 0);
      if (row.oldestPendingAt && (!result.oldestPendingAt || row.oldestPendingAt < result.oldestPendingAt)) {
        result.oldestPendingAt = row.oldestPendingAt;
      }
    });
    return result;
  }

  /** Capture the row-count evidence required before changing the outbox ledger policy. */
  async reportByOrganization(): Promise<OutboxOrganizationReport[]> {
    const reports: OutboxOrganizationReport[] = [];
    await forEachOrg(this.db, "outbox-events-report", async (tx, organizationId) => {
      const rows = await tx
        .select({
          totalRows: sql<number>`count(*)`,
          pending: sql<number>`count(*) filter (where ${outboxEvents.deliveryState} = 'PENDING')`,
          inFlight: sql<number>`count(*) filter (where ${outboxEvents.deliveryState} = 'IN_FLIGHT')`,
          dead: sql<number>`count(*) filter (where ${outboxEvents.deliveryState} = 'DEAD')`,
          oldestPendingAt: sql<Date | null>`min(${outboxEvents.createdAt}) filter (where ${outboxEvents.deliveryState} = 'PENDING')`,
          oldestEventAt: sql<Date | null>`min(${outboxEvents.createdAt})`,
          distinctEventTypes: sql<number>`count(distinct ${outboxEvents.eventType})`,
        })
        .from(outboxEvents);
      const row = rows[0];
      reports.push({
        organizationId,
        totalRows: Number(row?.totalRows ?? 0),
        pending: Number(row?.pending ?? 0),
        inFlight: Number(row?.inFlight ?? 0),
        dead: Number(row?.dead ?? 0),
        oldestPendingAt: row?.oldestPendingAt ?? null,
        oldestEventAt: row?.oldestEventAt ?? null,
        oldestEventAgeSeconds: row?.oldestEventAt
          ? Math.max(0, Math.floor((Date.now() - new Date(row.oldestEventAt).getTime()) / 1000))
          : null,
        distinctEventTypes: Number(row?.distinctEventTypes ?? 0),
      });
    });
    return reports;
  }

  /**
   * Returns both the rows and the sweep accounting. A plain array is insufficient evidence:
   * forEachOrg intentionally continues after a tenant failure, so a missing row must not be
   * mistaken for an empty outbox.
   */
  async report(): Promise<OutboxReport> {
    const reports: OutboxOrganizationReport[] = [];
    const result = await forEachOrg(this.db, "outbox-events-report", async (tx, organizationId) => {
      const rows = await tx
        .select({
          totalRows: sql<number>`count(*)`,
          pending: sql<number>`count(*) filter (where ${outboxEvents.deliveryState} = 'PENDING')`,
          inFlight: sql<number>`count(*) filter (where ${outboxEvents.deliveryState} = 'IN_FLIGHT')`,
          dead: sql<number>`count(*) filter (where ${outboxEvents.deliveryState} = 'DEAD')`,
          oldestPendingAt: sql<Date | null>`min(${outboxEvents.createdAt}) filter (where ${outboxEvents.deliveryState} = 'PENDING')`,
          oldestEventAt: sql<Date | null>`min(${outboxEvents.createdAt})`,
          distinctEventTypes: sql<number>`count(distinct ${outboxEvents.eventType})`,
        })
        .from(outboxEvents);
      const row = rows[0];
      reports.push({
        organizationId,
        totalRows: Number(row?.totalRows ?? 0),
        pending: Number(row?.pending ?? 0),
        inFlight: Number(row?.inFlight ?? 0),
        dead: Number(row?.dead ?? 0),
        oldestPendingAt: row?.oldestPendingAt ?? null,
        oldestEventAt: row?.oldestEventAt ?? null,
        oldestEventAgeSeconds: row?.oldestEventAt
          ? Math.max(0, Math.floor((Date.now() - new Date(row.oldestEventAt).getTime()) / 1000))
          : null,
        distinctEventTypes: Number(row?.distinctEventTypes ?? 0),
      });
    });
    return {
      generatedAt: new Date().toISOString(),
      organizations: result.organizations,
      succeeded: result.succeeded,
      failed: result.failed,
      reports,
    };
  }

  private async claimBatch(): Promise<OutboxEventRow[]> {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + LEASE_MS);
    const claimed: OutboxEventRow[] = [];

    await forEachOrg(this.db, "outbox-events-flush", async (tx, orgId) => {
      const remaining = BATCH_SIZE - claimed.length;
      if (remaining <= 0) return;

      const rows = await tx
        .update(outboxEvents)
        .set({
          deliveryState: "IN_FLIGHT",
          leaseExpiresAt: leaseUntil,
        })
        .where(
          sql`${outboxEvents.outboxEventId} in (
            select outbox_event_id from ${outboxEvents}
            where organization_id = ${orgId}
              and (
                (delivery_state = 'PENDING' and (lease_expires_at is null or lease_expires_at <= ${now.toISOString()}::timestamptz))
                or (delivery_state = 'IN_FLIGHT' and lease_expires_at <= ${now.toISOString()}::timestamptz)
              )
            order by outbox_event_id
            limit ${remaining}
            for update skip locked
          )`,
        )
        .returning();

      claimed.push(...rows);
    });

    return claimed;
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
    // Each consumer gets its own tenant transaction rather than sharing one:
    // a rollback in the second must not undo the first's work, and one long
    // consumer must not hold a pooled connection open for the others.
    for (const consumer of consumers) {
      await runInNewTenantTransaction(this.db, event.organizationId, async () => {
        await consumer.handle(event);
      });
    }
  }

  private async handleFailure(
    event: OutboxEventRow,
    error: unknown,
  ): Promise<"DEAD" | "RETRY" | "FENCED"> {
    const message = error instanceof Error ? error.message : String(error);
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
          leaseExpiresAt: new Date(Date.now() + nextRetryDelayMs(retryCount)),
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
