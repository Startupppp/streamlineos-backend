import { Injectable, Inject, BadRequestException, NotFoundException } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import { invWebhookEventSubscriptions, invWebhooks } from "../../../db/schema";
import { eq, and, desc } from "drizzle-orm";
import { randomBytes } from "crypto";
import { checkWebhookUrl } from "../../../common/security/ssrf-guard";
import { WebhookTransportService } from "./webhook-transport.service";
import {
  listDeadLetters,
  listEvents,
  retryEvent,
  type EventPage,
  type EventRow,
  type WebhookEventDeps,
} from "./lib/webhook-events";
import type { CreateWebhookInput, UpdateWebhookInput, ListEventsQueryInput } from "./dto/webhooks.schemas";

type WebhookRow = typeof invWebhooks.$inferSelect;

export type { EventPage, EventRow };

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

  private get eventDeps(): WebhookEventDeps {
    return { db: this.db, audit: this.audit, transport: this.transport, isProd: this.isProd };
  }

  listEvents(orgId: string, webhookId: number, query: ListEventsQueryInput): Promise<EventPage> {
    return listEvents(this.eventDeps, orgId, webhookId, query);
  }

  listDeadLetters(
    orgId: string,
    query: ListEventsQueryInput,
    webhookId?: number,
  ): Promise<EventPage> {
    return listDeadLetters(this.eventDeps, orgId, query, webhookId);
  }

  retryEvent(orgId: string, userId: string, eventId: number): Promise<EventRow> {
    return retryEvent(this.eventDeps, orgId, userId, eventId);
  }
}
