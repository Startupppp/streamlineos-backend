import { Injectable, Inject, BadRequestException, NotFoundException } from "@nestjs/common";
import { logger } from "../../../common/logger/logger.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import { invWebhookEventSubscriptions, invWebhooks, invWebhookEvents } from "../../../db/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import { createHmac, randomBytes } from "crypto";
import { checkWebhookUrl } from "../../../common/security/ssrf-guard";
import type { CreateWebhookInput, UpdateWebhookInput, ListEventsQueryInput } from "./dto/webhooks.schemas";

type WebhookRow = typeof invWebhooks.$inferSelect;
type EventRow = typeof invWebhookEvents.$inferSelect;

@Injectable()
export class WebhooksService {
  private readonly isProd = process.env.NODE_ENV === "production";

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: InventoryAuditService,
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

    const updated = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(invWebhooks)
        .set({
          ...(input.url !== undefined && { url: input.url }),
          ...(input.events !== undefined && { events: input.events }),
          ...(input.isActive !== undefined && { isActive: input.isActive }),
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

    const conditions = [
      eq(invWebhookEvents.orgId, orgId),
      eq(invWebhookEvents.webhookId, webhookId),
      ...(query.status ? [eq(invWebhookEvents.status, query.status)] : []),
    ];

    const offset = (query.page - 1) * query.limit;

    const rows = await this.db
      .select({
        id: invWebhookEvents.id,
        orgId: invWebhookEvents.orgId,
        webhookId: invWebhookEvents.webhookId,
        eventType: invWebhookEvents.eventType,
        payload: invWebhookEvents.payload,
        status: invWebhookEvents.status,
        attempts: invWebhookEvents.attempts,
        deliveredAt: invWebhookEvents.deliveredAt,
        createdAt: invWebhookEvents.createdAt,
        windowTotal: sql<string>`count(*) OVER ()`,
      })
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

    return {
      items,
      total,
      page: query.page,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  async retryEvent(orgId: string, userId: string, eventId: number): Promise<EventRow> {
    const eventRows = await this.db
      .select()
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

    const status = await this.deliverEvent(webhook, event);

    const [updatedEvent] = await this.db
      .update(invWebhookEvents)
      .set({
        status,
        attempts: event.attempts + 1,
        ...(status === "DELIVERED" && { deliveredAt: new Date() }),
      })
      .where(and(eq(invWebhookEvents.id, eventId), eq(invWebhookEvents.orgId, orgId)))
      .returning();

    await this.db
      .update(invWebhooks)
      .set({ lastDeliveryAt: new Date(), lastDeliveryStatus: status })
      .where(and(eq(invWebhooks.id, webhook.id), eq(invWebhooks.orgId, orgId)));

    await this.audit.insert(this.db, {
      orgId,
      actorUserId: userId,
      action: "webhook.event.retried",
      resourceType: "webhook_event",
      resourceId: String(eventId),
      after: { status, attempts: event.attempts + 1 },
    });

    return updatedEvent ?? event;
  }

  private async deliverEvent(
    webhook: WebhookRow,
    event: EventRow,
  ): Promise<"DELIVERED" | "FAILED"> {
    try {
      await this.assertSafeUrl(webhook.url);
    } catch (ssrfErr) {
      logger.warn("webhooks: SSRF guard blocked retry delivery", {
        orgId: webhook.orgId,
        webhookId: webhook.id,
        eventId: event.id,
        cause: ssrfErr instanceof Error ? ssrfErr.message : String(ssrfErr),
      });
      return "FAILED";
    }

    const payloadStr = JSON.stringify({
      id: event.id,
      type: event.eventType,
      data: event.payload,
      timestamp: event.createdAt,
    });
    const sig = createHmac("sha256", webhook.secret).update(payloadStr).digest("hex");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(webhook.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Inventory-Signature": `sha256=${sig}`,
        },
        body: payloadStr,
        signal: controller.signal,
        redirect: "manual",
      });
      clearTimeout(timeout);
      if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
        return "FAILED";
      }
      return res.ok ? "DELIVERED" : "FAILED";
    } catch (fetchErr) {
      clearTimeout(timeout);
      logger.warn("webhooks: retry delivery fetch failed", {
        orgId: webhook.orgId,
        webhookId: webhook.id,
        eventId: event.id,
        cause: fetchErr instanceof Error ? fetchErr.message : String(fetchErr),
      });
      return "FAILED";
    }
  }
}
