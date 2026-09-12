import { BadRequestException, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNotNull, sql, type SQL } from "drizzle-orm";
import { type Db } from "../../../../db/drizzle.module";
import { invWebhookEvents, invWebhooks } from "../../../../db/schema";
import type { InventoryAuditService } from "../../stock-engine/inventory-audit.service";
import type { WebhookTransportService } from "../webhook-transport.service";
import { planWebhookAttempt } from "../webhook-delivery-policy";
import type { ListEventsQueryInput } from "../dto/webhooks.schemas";

export type EventRow = typeof invWebhookEvents.$inferSelect;

export interface EventPage {
  items: EventRow[];
  total: number;
  page: number;
  totalPages: number;
}

/**
 * Reading the delivery log, and redelivering off it — lifted out of
 * `webhooks.service.ts` unchanged.
 *
 * The seam is the table. Everything left in the service registers a
 * subscription: it writes `inv_webhooks` and `inv_webhook_event_subscriptions`,
 * and its one interesting rule is the SSRF guard on the URL an admin supplies.
 * Everything here reads `inv_webhook_events` — rows this module wrote itself,
 * for an operator asking "did it go out, and if not why not". The two halves
 * already shared nothing but the db handle: no method below calls
 * `assertSafeUrl` or `syncSubscriptions`, and no method above touches
 * `eventColumns`. The one place they meet is `retryEvent`'s refusal to deliver
 * through a disabled subscription, which reads `inv_webhooks` and is documented
 * where it stands.
 */
export interface WebhookEventDeps {
  readonly db: Db;
  readonly audit: InventoryAuditService;
  readonly transport: WebhookTransportService;
  /** Mirrors the service's own `isProd`; `retryEvent` passes it to the transport. */
  readonly isProd: boolean;
}

/**
 * The event projection. `lastError`, `nextAttemptAt` and `deadLetteredAt` are
 * part of it because without them the list cannot answer the only question an
 * operator actually has: is this delivery still coming, and if not, why not.
 */
export const eventColumns = {
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

async function pageEvents(
  deps: WebhookEventDeps,
  conditions: SQL[],
  query: ListEventsQueryInput,
): Promise<EventPage> {
  const offset = (query.page - 1) * query.limit;

  const rows = await deps.db
    .select({ ...eventColumns, windowTotal: sql<string>`count(*) OVER ()` })
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
    const fallback = await deps.db
      .select({ n: sql<string>`count(*)` })
      .from(invWebhookEvents)
      .where(and(...conditions));
    total = Number(fallback[0]?.n ?? 0);
  }

  const items: EventRow[] = rows.map(({ windowTotal: _, ...rest }) => rest);

  return { items, total, page: query.page, totalPages: Math.ceil(total / query.limit) };
}

export async function listEvents(
  deps: WebhookEventDeps,
  orgId: string,
  webhookId: number,
  query: ListEventsQueryInput,
): Promise<EventPage> {
  const webhookCheck = await deps.db
    .select({ id: invWebhooks.id })
    .from(invWebhooks)
    .where(and(eq(invWebhooks.id, webhookId), eq(invWebhooks.orgId, orgId)))
    .limit(1);
  if (!webhookCheck[0]) throw new NotFoundException("Webhook not found");

  return pageEvents(
    deps,
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
export async function listDeadLetters(
  deps: WebhookEventDeps,
  orgId: string,
  query: ListEventsQueryInput,
  webhookId?: number,
): Promise<EventPage> {
  return pageEvents(
    deps,
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
export async function retryEvent(
  deps: WebhookEventDeps,
  orgId: string,
  userId: string,
  eventId: number,
): Promise<EventRow> {
  const eventRows = await deps.db
    .select(eventColumns)
    .from(invWebhookEvents)
    .where(and(eq(invWebhookEvents.id, eventId), eq(invWebhookEvents.orgId, orgId)))
    .limit(1);
  const event = eventRows[0];
  if (!event) throw new NotFoundException("Event not found");

  if (event.status === "DELIVERED") return event;

  if (event.webhookId === null) throw new NotFoundException("Webhook no longer exists");

  const webhookRows = await deps.db
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
  const outcome = await deps.transport.deliver(
    { id: webhook.id, url: webhook.url, secret: webhook.secret },
    {
      id: event.id,
      eventType: event.eventType,
      payload: event.payload,
      createdAt: event.createdAt,
      attempt: event.attempts + 1,
    },
    { requireHttps: deps.isProd },
  );

  const plan = planWebhookAttempt({ attempts: event.attempts, ok: outcome.ok, now });
  const status = plan.status === "DELIVERED" ? "DELIVERED" : "FAILED";

  const [updatedEvent] = await deps.db
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
    .returning();

  await deps.db
    .update(invWebhooks)
    .set({
      lastDeliveryAt: now,
      lastDeliveryStatus: status,
      ...(outcome.ok && { consecutiveFailures: 0, failingSince: null, alertedAt: null }),
    })
    .where(and(eq(invWebhooks.orgId, orgId), eq(invWebhooks.id, webhook.id)));

  await deps.audit.insert(deps.db, {
    orgId,
    actorUserId: userId,
    action: "webhook.event.retried",
    resourceType: "webhook_event",
    resourceId: String(eventId),
    after: { status, attempts: plan.attempts, ...(outcome.ok ? {} : { error: outcome.error }) },
  });

  return updatedEvent ?? event;
}
