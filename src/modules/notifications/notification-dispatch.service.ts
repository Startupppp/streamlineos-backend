import { Inject, Injectable, Logger, BadRequestException } from "@nestjs/common";
import { randomUUID } from "crypto";
import { inArray, eq, and } from "drizzle-orm";
import { notifications, notificationDeliveries, notificationQueue, notificationTemplates, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { NotificationEventRegistryService } from "./notification-event-registry.service";
import { NotificationRoutingService } from "./notification-routing.service";
import { NotificationsService, type NotificationCategoryValue, type AnnounceInput } from "./notifications.service";
import type { DispatchEventInput, NotificationChannel, NotificationEventDefinition } from "./notification.types";

type ProviderName = "INTERNAL" | "SMTP" | "WEB_PUSH" | "TWILIO" | "SLACK" | "TEAMS" | "WEBHOOK";

type RenderedTemplate = { subject: string | null; body: string };
type TemplateMap = Map<NotificationChannel, RenderedTemplate>;

const CHANNEL_TO_PROVIDER: Record<NotificationChannel, ProviderName> = {
  IN_APP: "INTERNAL",
  EMAIL: "SMTP",
  PUSH: "WEB_PUSH",
  SMS: "TWILIO",
  WHATSAPP: "TWILIO",
  SLACK: "SLACK",
  TEAMS: "TEAMS",
  WEBHOOK: "WEBHOOK",
};

export interface DispatchResult {
  eventKey: string;
  notified: number;
  deliveriesQueued: number;
  suppressed: number;
  deduped: number;
}

@Injectable()
export class NotificationDispatchService {
  private readonly logger = new Logger(NotificationDispatchService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly registry: NotificationEventRegistryService,
    private readonly routing: NotificationRoutingService,
    private readonly notificationsService: NotificationsService,
  ) {}

  async emit(input: DispatchEventInput): Promise<DispatchResult> {
    const resolved = await this.registry.resolveDefinition(input.orgId, input.eventKey);
    if (!resolved) throw new BadRequestException(`Unknown notification event: ${input.eventKey}`);
    const { definition, enabled } = resolved;

    const result: DispatchResult = { eventKey: input.eventKey, notified: 0, deliveriesQueued: 0, suppressed: 0, deduped: 0 };
    if (!enabled && !definition.mandatory) return result;

    const targets = Array.from(new Set(input.targetUserIds)).filter(Boolean);
    if (targets.length === 0) return result;

    const priority = input.priority ?? definition.defaultPriority;
    const emailRows = await this.db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(inArray(users.id, targets));
    const emailMap = new Map(emailRows.map((r) => [r.id, r.email]));

    const templateMap = await this.loadTemplates(input.orgId, definition, input.variables ?? {});

    const routingResults = await this.routing.routeMany(input.orgId, targets, definition, priority);
    const announcements: Array<{ input: AnnounceInput; pushToDevices: boolean }> = [];
    for (const userId of targets) {
      const routingResult = routingResults.get(userId);
      if (!routingResult) continue;
      const perUser = await this.persistForUser(input, definition, userId, routingResult, emailMap.get(userId) ?? null, templateMap);
      result.notified += perUser.createdInApp ? 1 : 0;
      result.deliveriesQueued += perUser.queued;
      result.suppressed += perUser.suppressed;
      result.deduped += perUser.deduped ? 1 : 0;
      if (perUser.announce) announcements.push({ input: perUser.announce, pushToDevices: !perUser.pushHandledByEngine });
    }

    await Promise.all(
      announcements.map((a) => this.notificationsService.announce(a.input, a.pushToDevices)),
    );
    return result;
  }

  private async loadTemplates(orgId: string, definition: NotificationEventDefinition, variables: Record<string, unknown>): Promise<TemplateMap> {
    if (!definition.templateKey) return new Map();

    const rows = await this.db.query.notificationTemplates.findMany({
      where: and(
        eq(notificationTemplates.orgId, orgId),
        eq(notificationTemplates.templateKey, definition.templateKey),
        eq(notificationTemplates.isActive, true),
      ),
    });

    const stringVars: Record<string, string> = Object.fromEntries(
      Object.entries(variables).map(([k, v]) => [k, v == null ? "" : String(v)]),
    );

    const byChannel = new Map<NotificationChannel, typeof rows>();
    for (const row of rows) {
      const ch = row.channel as NotificationChannel;
      const existing = byChannel.get(ch);
      if (!existing) {
        byChannel.set(ch, [row]);
      } else {
        existing.push(row);
      }
    }

    const map: TemplateMap = new Map();
    for (const [channel, channelRows] of byChannel) {
      const preferred = channelRows.find((r) => r.locale === "en") ?? channelRows[0];
      if (!preferred) continue;
      map.set(channel, {
        subject: preferred.subject != null ? this.renderPlaceholders(preferred.subject, stringVars) : null,
        body: this.renderPlaceholders(preferred.body, stringVars),
      });
    }

    return map;
  }

  private renderPlaceholders(template: string, variables: Record<string, string>): string {
    return template.replace(/\{\{([^}]+)\}\}/g, (_, key: string) => variables[key.trim()] ?? "");
  }

  private buildIdempotencyKey(input: DispatchEventInput, userId: string, channel: NotificationChannel, dedupeWindowSeconds: number): string {
    const entity = `${input.entityType ?? ""}:${input.entityId ?? ""}`;
    const bucket = dedupeWindowSeconds > 0 ? Math.floor(Date.now() / (dedupeWindowSeconds * 1000)).toString() : randomUUID();
    return `org:${input.orgId}:event:${input.eventKey}:user:${userId}:entity:${entity}:channel:${channel}:dedupe:${bucket}`;
  }

  private async persistForUser(
    input: DispatchEventInput,
    definition: NotificationEventDefinition,
    userId: string,
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
      const inAppKey = this.buildIdempotencyKey(input, userId, "IN_APP", definition.dedupeWindowSeconds);
      const [inAppDelivery] = await tx
        .insert(notificationDeliveries)
        .values({
          orgId: input.orgId,
          userId,
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
      if (createInApp) {
        const [notification] = await tx
          .insert(notifications)
          .values({
            orgId: input.orgId,
            userId,
            type: definition.defaultType,
            priority: routingResult.priority,
            category: definition.category as NotificationCategoryValue,
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
          .returning({ id: notifications.id });
        notificationId = notification?.id ?? null;
        if (notificationId) {
          await tx.update(notificationDeliveries).set({ notificationId }).where(eq(notificationDeliveries.id, inAppDelivery.id));
        }
      }

      let queued = 0;
      let suppressed = createInApp ? 0 : 1;
      for (const decision of routingResult.channels) {
        if (decision.channel === "IN_APP") continue;
        const key = this.buildIdempotencyKey(input, userId, decision.channel, definition.dedupeWindowSeconds);
        const isSend = decision.action === "SEND";
        const recipientAddress = decision.channel === "EMAIL" ? email : null;
        const channelTemplate = templateMap.get(decision.channel);
        const deliveryTitle = channelTemplate ? (channelTemplate.subject ?? fallbackTitle) : fallbackTitle;
        const deliveryMessage = channelTemplate ? channelTemplate.body : fallbackMessage;
        const [delivery] = await tx
          .insert(notificationDeliveries)
          .values({
            notificationId,
            orgId: input.orgId,
            userId,
            eventKey: input.eventKey,
            channel: decision.channel,
            provider: CHANNEL_TO_PROVIDER[decision.channel],
            recipientAddress,
            status: isSend ? "QUEUED" : "SUPPRESSED",
            priority: routingResult.priority,
            suppressionReason: isSend ? null : decision.reason ?? null,
            nextAttemptAt: isSend ? (routingResult.deferredUntil ?? now) : null,
            idempotencyKey: key,
            metadata: { title: deliveryTitle, message: deliveryMessage, link: input.link ?? null },
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
