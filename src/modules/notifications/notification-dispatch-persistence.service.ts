import { Inject, Injectable } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { notifications, notificationDeliveries, notificationQueue } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { buildNotifIdempotencyKey } from "./notification-dispatch-keys";
import type { NotificationRoutingService } from "./notification-routing.service";
import type { AnnounceInput } from "./notifications.service";
import type { TemplateMap } from "./notification-template-renderer.service";
import type {
  DispatchEventInput,
  NotificationChannel,
  NotificationEventDefinition,
  NotificationPriority,
} from "./notification.types";

type ProviderName = "INTERNAL" | "SMTP" | "WEB_PUSH" | "TWILIO" | "WEBHOOK";

const CHANNEL_TO_PROVIDER: Record<NotificationChannel, ProviderName> = {
  IN_APP: "INTERNAL",
  EMAIL: "SMTP",
  PUSH: "WEB_PUSH",
  SMS: "TWILIO",
  WHATSAPP: "TWILIO",
  WEBHOOK: "WEBHOOK",
};

@Injectable()
export class NotificationDispatchPersistenceService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * Records that a recipient was withheld for lack of access. Written as a real
   * delivery row so the suppression is auditable and distinguishable from a mute —
   * "we never sent it" and "we sent it and they lost access" are different answers
   * when a customer asks. Uses the same idempotency key as a normal IN_APP delivery,
   * so a replayed dispatch does not double-record.
   */
  public async recordAccessSuppression(
    input: DispatchEventInput,
    definition: NotificationEventDefinition,
    userId: string,
    membershipId: number | null,
    priority: NotificationPriority,
  ): Promise<number> {
    const [row] = await this.db
      .insert(notificationDeliveries)
      .values({
        orgId: input.orgId,
        userId,
        membershipId,
        eventKey: input.eventKey,
        channel: "IN_APP",
        provider: "INTERNAL",
        status: "SUPPRESSED",
        priority,
        suppressionReason: "NO_ACCESS",
        idempotencyKey: buildNotifIdempotencyKey(input, userId, "IN_APP", definition.dedupeWindowSeconds),
        metadata: {
          resourceKind: definition.visibilityResourceKind ?? null,
          entityType: input.entityType ?? null,
          entityId: input.entityId ?? null,
        },
      })
      .onConflictDoNothing({ target: notificationDeliveries.idempotencyKey })
      .returning({ id: notificationDeliveries.id });
    return row ? 1 : 0;
  }

  public async persistForUser(
    input: DispatchEventInput,
    definition: NotificationEventDefinition,
    userId: string,
    membershipId: number | null,
    routingResult: Awaited<ReturnType<NotificationRoutingService["route"]>>,
    email: string | null,
    templateMap: TemplateMap,
  ): Promise<{ createdInApp: boolean; queued: number; suppressed: number; deduped: boolean; announce?: AnnounceInput; pushHandledByEngine: boolean }> {
    const now = new Date();
    const fallbackTitle = input.title ?? definition.displayName;
    const fallbackMessage = input.message ?? definition.description;
    const inAppTemplate = templateMap.get("IN_APP");
    const title = inAppTemplate ? (inAppTemplate.subject ?? fallbackTitle) : fallbackTitle;
    const message = inAppTemplate ? inAppTemplate.body : fallbackMessage;
    const createInApp = routingResult.createInApp;
    const pushHandledByEngine = routingResult.channels.some((c) => c.channel === "PUSH" && c.action === "SEND");

    return this.db.transaction(async (tx) => {
      const inAppKey = buildNotifIdempotencyKey(input, userId, "IN_APP", definition.dedupeWindowSeconds);
      const [inAppDelivery] = await tx
        .insert(notificationDeliveries)
        .values({
          orgId: input.orgId,
          userId,
          membershipId,
          eventKey: input.eventKey,
          channel: "IN_APP",
          provider: "INTERNAL",
          status: createInApp ? "DELIVERED" : "SUPPRESSED",
          priority: routingResult.priority,
          deliveredAt: createInApp ? now : null,
          suppressionReason: createInApp ? null : "CHANNEL_DISABLED",
          idempotencyKey: inAppKey,
          metadata: { title, message, link: input.link ?? null },
        })
        .onConflictDoNothing({ target: notificationDeliveries.idempotencyKey })
        .returning({ id: notificationDeliveries.id });

      if (!inAppDelivery) {
        return { createdInApp: false, queued: 0, suppressed: 0, deduped: true, announce: undefined, pushHandledByEngine };
      }

      let notificationId: number | null = null;
      let notificationCreatedAt: Date | null = null;
      if (createInApp) {
        const [notification] = await tx
          .insert(notifications)
          .values({
            orgId: input.orgId,
            userId,
            membershipId,
            type: definition.defaultType,
            priority: routingResult.priority,
            category: definition.category,
            sourceModule: definition.sourceModule,
            eventKey: input.eventKey,
            entityType: input.entityType,
            entityId: input.entityId,
            actorUserId: input.actorUserId ?? null,
            reason: routingResult.reasonText,
            title,
            message,
            link: input.link,
            channel: "IN_APP",
            metadata: input.metadata,
          })
          .returning({ id: notifications.id, createdAt: notifications.createdAt });
        notificationId = notification?.id ?? null;
        notificationCreatedAt = notification?.createdAt ?? null;
        if (notificationId) {
          await tx
            .update(notificationDeliveries)
            .set({
              notificationId,
              notificationCreatedAt: sql`(
                select created_at from notifications where id = ${notificationId}
              )`,
            })
            .where(eq(notificationDeliveries.id, inAppDelivery.id));
        }
      }

      let queued = 0;
      let suppressed = createInApp ? 0 : 1;
      for (const decision of routingResult.channels) {
        if (decision.channel === "IN_APP") continue;
        const key = buildNotifIdempotencyKey(input, userId, decision.channel, definition.dedupeWindowSeconds);
        const isSend = decision.action === "SEND";
        const recipientAddress = decision.channel === "EMAIL" ? email : null;
        const channelTemplate = templateMap.get(decision.channel);
        const deliveryTitle = channelTemplate ? (channelTemplate.subject ?? fallbackTitle) : fallbackTitle;
        const deliveryMessage = channelTemplate ? channelTemplate.body : fallbackMessage;
        const [delivery] = await tx
          .insert(notificationDeliveries)
          .values({
            notificationId,
            notificationCreatedAt: notificationId
              ? sql`(select created_at from notifications where id = ${notificationId})`
              : null,
            orgId: input.orgId,
            userId,
            membershipId,
            eventKey: input.eventKey,
            channel: decision.channel,
            provider: CHANNEL_TO_PROVIDER[decision.channel],
            recipientAddress,
            status: isSend ? "QUEUED" : "SUPPRESSED",
            priority: routingResult.priority,
            suppressionReason: isSend ? null : decision.reason ?? null,
            nextAttemptAt: isSend ? (routingResult.deferredUntil ?? now) : null,
            idempotencyKey: key,
            metadata: {
              ...(input.metadata ?? {}),
              ...(input.emailHtml ? { emailHtml: input.emailHtml } : {}),
              ...(input.attachments ? { attachments: input.attachments } : {}),
              title: deliveryTitle,
              message: deliveryMessage,
              link: input.link ?? null,
            },
            // REG-008: the snapshot of what was actually sent. metadata above is the
            // display payload; these two are the audit record, and survive a later
            // edit to the template they came from.
            renderedSubject: deliveryTitle,
            renderedBody: deliveryMessage,
            // PIPE-012: past this the worker drops rather than delivers stale.
            expiresAt: definition.ttlSeconds
              ? new Date(now.getTime() + definition.ttlSeconds * 1000)
              : null,
          })
          .onConflictDoNothing({ target: notificationDeliveries.idempotencyKey })
          .returning({ id: notificationDeliveries.id });

        if (!delivery) continue;
        if (isSend) {
          await tx.insert(notificationQueue).values({
            deliveryId: delivery.id,
            orgId: input.orgId,
            channel: decision.channel,
            runAt: routingResult.deferredUntil ?? now,
            status: "PENDING",
          });
          queued += 1;
        } else {
          suppressed += 1;
        }
      }

      const announce: AnnounceInput | undefined =
        createInApp && notificationId !== null
          ? {
              id: notificationId,
              userId,
              orgId: input.orgId,
              title,
              message,
              priority: routingResult.priority,
              category: definition.category,
              link: input.link ?? null,
              sourceModule: definition.sourceModule,
              eventKey: input.eventKey,
            }
          : undefined;

      return { createdInApp: createInApp && notificationId !== null, queued, suppressed, deduped: false, announce, pushHandledByEngine };
    });
  }
}
