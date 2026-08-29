import { Injectable, Inject, BadRequestException, NotFoundException } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import { invWebhookEventSubscriptions, invWebhooks, invWebhookEvents } from "../../../db/schema";
import { eq, and, desc, isNotNull, sql, type SQL } from "drizzle-orm";
import { randomBytes } from "crypto";
import { checkWebhookUrl } from "../../../common/security/ssrf-guard";
import { WebhookTransportService } from "./webhook-transport.service";
import { planWebhookAttempt } from "./webhook-delivery-policy";
import type { CreateWebhookInput, UpdateWebhookInput, ListEventsQueryInput } from "./dto/webhooks.schemas";

type WebhookRow = typeof invWebhooks.$inferSelect;
type EventRow = typeof invWebhookEvents.$inferSelect;

@Injectable()
export class WebhooksService {
  private readonly isProd = process.env.NODE_ENV === "production";

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: InventoryAuditService,
    private readonly transport: WebhookTransportService,
  ) {}

  private async assertSafeUrl(url: string): Promise<void> {
    if (this.isProd) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new BadRequestException("Invalid URL");
      }
      if (parsed.protocol !== "https:") throw new BadRequestException("Only HTTPS URLs allowed in production");
    }
    const result = await checkWebhookUrl(url);
    if (result.allowed) return;
    switch (result.reason) {
      case "invalid-url":
        throw new BadRequestException("Invalid URL");
      case "unsupported-scheme":
        throw new BadRequestException("Only HTTP/HTTPS URLs allowed");
      case "unresolvable-host":
        throw new BadRequestException("Webhook hostname could not be resolved");
      case "blocked-address":
        throw new BadRequestException("Webhook URL resolves to a blocked address");
    }
  }

  async list(orgId: string): Promise<Omit<WebhookRow, "secret">[]> {
    const rows = await this.db
      .select()
      .from(invWebhooks)
      .where(eq(invWebhooks.orgId, orgId))
      .orderBy(desc(invWebhooks.createdAt));
    return rows.map(({ secret: _, ...safe }) => safe);
  }

  private async syncSubscriptions(
    tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
    orgId: string,
    webhookId: number,
    events: readonly string[],
  ): Promise<void> {
    await tx
      .delete(invWebhookEventSubscriptions)
      .where(
        and(
          eq(invWebhookEventSubscriptions.orgId, orgId),
          eq(invWebhookEventSubscriptions.webhookId, webhookId),
        ),
      );
    const unique = Array.from(new Set(events));
    if (unique.length === 0) return;
    await tx
      .insert(invWebhookEventSubscriptions)
      .values(unique.map((eventType) => ({ orgId, webhookId, eventType })))
      .onConflictDoNothing();
  }

  async create(orgId: string, userId: string, input: CreateWebhookInput): Promise<WebhookRow> {
    await this.assertSafeUrl(input.url);

    const secret = randomBytes(32).toString("hex");
    const created = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(invWebhooks)
        .values({ orgId, url: input.url, events: input.events, secret, isActive: input.isActive })
        .returning();
      if (!row) return undefined;
      await this.syncSubscriptions(tx, orgId, row.id, input.events);
      return row;
    });

    if (!created) throw new BadRequestException("Failed to create webhook");

    await this.audit.insert(this.db, {
      orgId,
      actorUserId: userId,
      action: "webhook.created",
      resourceType: "webhook",
      resourceId: String(created.id),
      after: { url: created.url, events: created.events },
    });

    return created;
  }

  async update(
    orgId: string,
    userId: string,
    webhookId: number,
    input: UpdateWebhookInput,
  ): Promise<Omit<WebhookRow, "secret">> {
    const existing = await this.db
      .select()
      .from(invWebhooks)
      .where(and(eq(invWebhooks.id, webhookId), eq(invWebhooks.orgId, orgId)))
      .limit(1);
    if (!existing[0]) throw new NotFoundException("Webhook not found");

    if (input.url) {
      await this.assertSafeUrl(input.url);
    }

    /**
     * E7. Re-enabling clears the health counters.
     *
     * Without this, a webhook the policy auto-disabled comes back with
     * `consecutiveFailures` still at the disable threshold and `alertedAt` still
     * stamped: the very next dead letter disables it again, and the alert that is
     * supposed to precede that is suppressed as already-sent. Changing the URL
     * clears them for the same reason — it is a different endpoint, and it does
     * not inherit the old one's outage.
     */
    const reactivating =
      (input.isActive === true && !existing[0].isActive) ||
      (input.url !== undefined && input.url !== existing[0].url);

    const updated = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(invWebhooks)
        .set({
          ...(input.url !== undefined && { url: input.url }),
          ...(input.events !== undefined && { events: input.events }),
          ...(input.isActive !== undefined && { isActive: input.isActive }),
          ...(reactivating && {
            consecutiveFailures: 0,
            failingSince: null,
            alertedAt: null,
            disabledAt: null,
            disabledReason: null,
          }),
        })
        .where(and(eq(invWebhooks.id, webhookId), eq(invWebhooks.orgId, orgId)))
        .returning();
      if (!row) return undefined;
      if (input.events !== undefined)
        await this.syncSubscriptions(tx, orgId, webhookId, input.events);
      return row;
    });

    if (!updated) throw new NotFoundException("Webhook not found");

    await this.audit.insert(this.db, {
      orgId,
      actorUserId: userId,
      action: "webhook.updated",
      resourceType: "webhook",
      resourceId: String(webhookId),
      before: { url: existing[0].url, events: existing[0].events, isActive: existing[0].isActive },
      after: { url: updated.url, events: updated.events, isActive: updated.isActive },
    });

    const { secret: _, ...safe } = updated;
    return safe;
  }

  async remove(orgId: string, userId: string, webhookId: number): Promise<{ deleted: boolean }> {
    const existing = await this.db
      .select()
      .from(invWebhooks)
      .where(and(eq(invWebhooks.id, webhookId), eq(invWebhooks.orgId, orgId)))
      .limit(1);
    if (!existing[0]) throw new NotFoundException("Webhook not found");

    await this.db
      .delete(invWebhooks)
      .where(and(eq(invWebhooks.id, webhookId), eq(invWebhooks.orgId, orgId)));

    await this.audit.insert(this.db, {
      orgId,
      actorUserId: userId,
      action: "webhook.deleted",
      resourceType: "webhook",
      resourceId: String(webhookId),
      before: { url: existing[0].url },
    });

    return { deleted: true };
  }

  /**
   * The event projection. `lastError`, `nextAttemptAt` and `deadLetteredAt` are
   * part of it because without them the list cannot answer the only question an
   * operator actually has: is this delivery still coming, and if not, why not.
   */
  private readonly eventColumns = {
    id: invWebhookEvents.id,
    orgId: invWebhookEvents.orgId,
    webhookId: invWebhookEvents.webhookId,
    eventType: invWebhookEvents.eventType,
    payload: invWebhookEvents.payload,
    status: invWebhookEvents.status,
    attempts: invWebhookEvents.attempts,
    deliveredAt: invWebhookEvents.deliveredAt,
    dedupeKey: invWebhookEvents.dedupeKey,
    nextAttemptAt: invWebhookEvents.nextAttemptAt,
    leaseExpiresAt: invWebhookEvents.leaseExpiresAt,
    lastAttemptAt: invWebhookEvents.lastAttemptAt,
    lastError: invWebhookEvents.lastError,
    deadLetteredAt: invWebhookEvents.deadLetteredAt,
    createdAt: invWebhookEvents.createdAt,
  };

  private async pageEvents(
    conditions: SQL[],
    query: ListEventsQueryInput,
  ): Promise<{ items: EventRow[]; total: number; page: number; totalPages: number }> {
    const offset = (query.page - 1) * query.limit;

    const rows = await this.db
      .select({ ...this.eventColumns, windowTotal: sql<string>`count(*) OVER ()` })
      .from(invWebhookEvents)
      .where(and(...conditions))
      .orderBy(desc(invWebhookEvents.createdAt))
      .limit(query.limit)
      .offset(offset);

    const first = rows[0];
    let total: number;
    if (first) {
      total = Number(first.windowTotal);
    } else if (offset === 0) {
      total = 0;
    } else {
      const fallback = await this.db
        .select({ n: sql<string>`count(*)` })
        .from(invWebhookEvents)
        .where(and(...conditions));
      total = Number(fallback[0]?.n ?? 0);
    }

    const items: EventRow[] = rows.map(({ windowTotal: _, ...rest }) => rest);

    return { items, total, page: query.page, totalPages: Math.ceil(total / query.limit) };
  }

  async listEvents(
    orgId: string,
    webhookId: number,
    query: ListEventsQueryInput,
  ): Promise<{ items: EventRow[]; total: number; page: number; totalPages: number }> {
    const webhookCheck = await this.db
      .select({ id: invWebhooks.id })
      .from(invWebhooks)
      .where(and(eq(invWebhooks.id, webhookId), eq(invWebhooks.orgId, orgId)))
      .limit(1);
    if (!webhookCheck[0]) throw new NotFoundException("Webhook not found");

    return this.pageEvents(
      [
        eq(invWebhookEvents.orgId, orgId),
        eq(invWebhookEvents.webhookId, webhookId),
        ...(query.status ? [eq(invWebhookEvents.status, query.status)] : []),
      ],
      query,
    );
  }

  /**
   * E7 — the dead-letter list.
   *
   * Deliberately org-wide rather than per webhook: the reason to open this screen
   * is "did we drop anything", and asking that one subscription at a time means
   * the answer for a subscription nobody thought to check is no answer at all.
   * `deadLetteredAt is not null` is the predicate rather than `status = 'FAILED'`
   * — status is also where a merely-retrying row would land under any future
   * relabelling, and an events list that quietly includes work still in flight is
   * worse than no list.
   */
  async listDeadLetters(
    orgId: string,
    query: ListEventsQueryInput,
    webhookId?: number,
  ): Promise<{ items: EventRow[]; total: number; page: number; totalPages: number }> {
    return this.pageEvents(
      [
        eq(invWebhookEvents.orgId, orgId),
        isNotNull(invWebhookEvents.deadLetteredAt),
        ...(webhookId !== undefined ? [eq(invWebhookEvents.webhookId, webhookId)] : []),
      ],
      query,
    );
  }

  /**
   * Manual redelivery of one event, from the dead-letter list.
   *
   * It goes through the same `WebhookTransportService` the worker uses, so the
   * button cannot drift onto a different signing scheme from the automatic path —
   * which is exactly what had happened: this method carried its own copy of the
   * body, the HMAC and the fetch.
   */
  async retryEvent(orgId: string, userId: string, eventId: number): Promise<EventRow> {
    const eventRows = await this.db
      .select(this.eventColumns)
      .from(invWebhookEvents)
      .where(and(eq(invWebhookEvents.id, eventId), eq(invWebhookEvents.orgId, orgId)))
      .limit(1);
    const event = eventRows[0];
    if (!event) throw new NotFoundException("Event not found");

    if (event.status === "DELIVERED") return event;

    if (event.webhookId === null) throw new NotFoundException("Webhook no longer exists");

    const webhookRows = await this.db
      .select()
      .from(invWebhooks)
      .where(and(eq(invWebhooks.id, event.webhookId), eq(invWebhooks.orgId, orgId)))
      .limit(1);
    const webhook = webhookRows[0];
    if (!webhook) throw new NotFoundException("Webhook no longer exists");

    // Refusing rather than delivering anyway: a disabled subscription is either an
    // admin's decision or this module's, and honouring a retry through it would
    // send traffic to the endpoint the disable exists to stop sending to. The fix
    // is to re-enable — which clears the health counters — and retry then.
    if (!webhook.isActive) {
      throw new BadRequestException(
        webhook.disabledReason
          ? `Webhook is disabled (${webhook.disabledReason}); re-enable it before retrying`
          : "Webhook is disabled; re-enable it before retrying",
      );
    }

    const now = new Date();
    const outcome = await this.transport.deliver(
      { id: webhook.id, url: webhook.url, secret: webhook.secret },
      {
        id: event.id,
        eventType: event.eventType,
        payload: event.payload,
        createdAt: event.createdAt,
        attempt: event.attempts + 1,
      },
      { requireHttps: this.isProd },
    );

    const plan = planWebhookAttempt({ attempts: event.attempts, ok: outcome.ok, now });
    const status = plan.status === "DELIVERED" ? "DELIVERED" : "FAILED";

    const [updatedEvent] = await this.db
      .update(invWebhookEvents)
      .set({
        status: plan.status,
        attempts: plan.attempts,
        nextAttemptAt: plan.nextAttemptAt,
        deliveredAt: plan.deliveredAt,
        // A successful manual retry takes the event back out of the dead-letter
        // list; a failed one leaves whatever put it there in place.
        deadLetteredAt: outcome.ok ? null : (plan.deadLetteredAt ?? event.deadLetteredAt),
        lastAttemptAt: now,
        lastError: outcome.ok ? null : outcome.error,
      })
      .where(and(eq(invWebhookEvents.orgId, orgId), eq(invWebhookEvents.id, eventId)))
      .returning(this.eventColumns);

    await this.db
      .update(invWebhooks)
      .set({
        lastDeliveryAt: now,
        lastDeliveryStatus: status,
        ...(outcome.ok && { consecutiveFailures: 0, failingSince: null, alertedAt: null }),
      })
      .where(and(eq(invWebhooks.orgId, orgId), eq(invWebhooks.id, webhook.id)));

    await this.audit.insert(this.db, {
      orgId,
      actorUserId: userId,
      action: "webhook.event.retried",
      resourceType: "webhook_event",
      resourceId: String(eventId),
      after: { status, attempts: plan.attempts, ...(outcome.ok ? {} : { error: outcome.error }) },
    });

    return updatedEvent ?? event;
  }
}
