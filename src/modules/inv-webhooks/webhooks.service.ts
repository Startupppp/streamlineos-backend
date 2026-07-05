import { Injectable, Inject, BadRequestException, NotFoundException } from "@nestjs/common";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { InventoryAuditService } from "../inv-stock-engine/inventory-audit.service";
import { invWebhooks, invWebhookEvents } from "../../db/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import { createHmac, randomBytes } from "crypto";
import type { CreateWebhookInput, UpdateWebhookInput, ListEventsQueryInput } from "./dto/webhooks.schemas";

export function validateWebhookUrl(url: string, isProd: boolean): string | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return "Invalid URL"; }
  if (isProd && parsed.protocol !== "https:") return "Only HTTPS URLs allowed in production";
  if (!["http:", "https:"].includes(parsed.protocol)) return "Only HTTP/HTTPS URLs allowed";
  const host = parsed.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host.startsWith("127.")) return "Localhost URLs not allowed";
  if (host === "::1" || host === "[::1]") return "Localhost URLs not allowed";
  if (/^169\.254\./.test(host)) return "Link-local addresses not allowed";
  if (/^10\./.test(host)) return "Private IP ranges not allowed";
  if (/^192\.168\./.test(host)) return "Private IP ranges not allowed";
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return "Private IP ranges not allowed";
  if (host === "169.254.169.254") return "Metadata endpoints not allowed";
  return null;
}

type WebhookRow = typeof invWebhooks.$inferSelect;
type EventRow = typeof invWebhookEvents.$inferSelect;

@Injectable()
export class WebhooksService {
  private readonly isProd = process.env.NODE_ENV === "production";

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: InventoryAuditService,
  ) {}

  async list(orgId: string): Promise<Omit<WebhookRow, "secret">[]> {
    const rows = await this.db
      .select()
      .from(invWebhooks)
      .where(eq(invWebhooks.orgId, orgId))
      .orderBy(desc(invWebhooks.createdAt));
    return rows.map(({ secret: _s, ...safe }) => safe);
  }

  async create(orgId: string, userId: string, input: CreateWebhookInput): Promise<WebhookRow> {
    const urlError = validateWebhookUrl(input.url, this.isProd);
    if (urlError) throw new BadRequestException(urlError);

    const secret = randomBytes(32).toString("hex");
    const [created] = await this.db
      .insert(invWebhooks)
      .values({ orgId, url: input.url, events: input.events, secret, isActive: input.isActive })
      .returning();

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
      const urlError = validateWebhookUrl(input.url, this.isProd);
      if (urlError) throw new BadRequestException(urlError);
    }

    const [updated] = await this.db
      .update(invWebhooks)
      .set({
        ...(input.url !== undefined && { url: input.url }),
        ...(input.events !== undefined && { events: input.events }),
        ...(input.isActive !== undefined && { isActive: input.isActive }),
      })
      .where(and(eq(invWebhooks.id, webhookId), eq(invWebhooks.orgId, orgId)))
      .returning();

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

    const { secret: _s, ...safe } = updated;
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

    const [countRow] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(invWebhookEvents)
      .where(and(...conditions));

    const total = countRow?.count ?? 0;
    const offset = (query.page - 1) * query.limit;

    const items = await this.db
      .select()
      .from(invWebhookEvents)
      .where(and(...conditions))
      .orderBy(desc(invWebhookEvents.createdAt))
      .limit(query.limit)
      .offset(offset);

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
      .where(eq(invWebhookEvents.id, eventId))
      .returning();

    await this.db
      .update(invWebhooks)
      .set({ lastDeliveryAt: new Date(), lastDeliveryStatus: status })
      .where(eq(invWebhooks.id, webhook.id));

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
    const payloadStr = JSON.stringify({
      id: event.id,
      type: event.eventType,
      data: event.payload,
      timestamp: event.createdAt,
    });
    const sig = createHmac("sha256", webhook.secret).update(payloadStr).digest("hex");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(webhook.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Inventory-Signature": `sha256=${sig}`,
        },
        body: payloadStr,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return res.ok ? "DELIVERED" : "FAILED";
    } catch {
      clearTimeout(timeout);
      return "FAILED";
    }
  }
}
