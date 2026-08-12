import { Inject, Injectable, BadRequestException, Logger } from "@nestjs/common";
import { randomUUID } from "crypto";
import { inArray, eq, and } from "drizzle-orm";
import { notifications, notificationDeliveries, notificationQueue, notificationOutbox, notificationPreferences, notificationTemplates, userPreferences, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import { NOTIF_CACHE } from "./notification-cache-keys";
import { NotificationEventRegistryService } from "./notification-event-registry.service";
import { NotificationRoutingService } from "./notification-routing.service";
import { NotificationsService, type AnnounceInput } from "./notifications.service";
import { NotificationVisibilityRegistry } from "./notification-visibility.registry";
import { NotificationTemplateRenderer, type TemplateMap } from "./notification-template-renderer.service";
import { NotificationDigestService } from "./notification-digest.service";
import type {
  DispatchEventInput,
  NotificationChannel,
  NotificationEventDefinition,
  NotificationPriority,
} from "./notification.types";
import { filterOrgMemberIds } from "../../common/tenant/org-membership";
import { registerAfterCommit } from "../../common/tenant/tenant-context";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { type DbOrTx } from "../../common/rbac/access-invalidate";

type ProviderName = "INTERNAL" | "SMTP" | "WEB_PUSH" | "TWILIO" | "WEBHOOK";


/**
 * PIPE-006. How many recipients are persisted at once. Sized against the Postgres
 * pool rather than the recipient count — higher only queues work inside the driver.
 */
const FANOUT_CONCURRENCY = 10;

const CHANNEL_TO_PROVIDER: Record<NotificationChannel, ProviderName> = {
  IN_APP: "INTERNAL",
  EMAIL: "SMTP",
  PUSH: "WEB_PUSH",
  SMS: "TWILIO",
  WHATSAPP: "TWILIO",
  WEBHOOK: "WEBHOOK",
};

export interface DispatchResult {
  eventKey: string;
  notified: number;
  deliveriesQueued: number;
  suppressed: number;
  deduped: number;
  deferred: boolean;
}

@Injectable()
export class NotificationDispatchService {
  private readonly logger = new Logger(NotificationDispatchService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly registry: NotificationEventRegistryService,
    private readonly routing: NotificationRoutingService,
    private readonly notificationsService: NotificationsService,
    private readonly cache: CacheService,
    private readonly visibility: NotificationVisibilityRegistry,
    private readonly templates: NotificationTemplateRenderer,
    private readonly digest: NotificationDigestService,
  ) {}

  /**
   * PIPE-001. Durable overload: writes the intent inside the caller's transaction, so
   * the domain change and the notification commit together or not at all. Prefer this
   * wherever a transaction is already open — `emit(input)` defers with an in-memory
   * hook and loses the notification if the process dies before it drains.
   *
   * The relay (`NotificationOutboxRelayService`) picks the row up and runs the same
   * `emitNow` pipeline, so routing, preferences and the PIPE-003 visibility check are
   * unchanged. Only the trigger becomes durable.
   */
  async emitDurable(tx: DbOrTx, input: DispatchEventInput): Promise<void> {
    await tx
      .insert(notificationOutbox)
      .values({
        orgId: input.orgId,
        eventKey: input.eventKey,
        dedupeKey: this.buildOutboxDedupeKey(input),
        actorUserId: input.actorUserId ?? null,
        notifySelf: input.notifySelf ?? false,
        targetUserIds: input.targetUserIds,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        title: input.title ?? null,
        message: input.message ?? null,
        link: input.link ?? null,
        variables: (input.variables ?? {}) as Record<string, unknown>,
        metadata: input.metadata ?? null,
      })
      // Same intent from a retried request is a no-op, not a second notification.
      .onConflictDoNothing({
        target: [notificationOutbox.orgId, notificationOutbox.dedupeKey],
      });
  }

  /**
   * Stable across retries of the same logical request: same event, same recipients,
   * same entity → same key. Deliberately excludes the timestamp.
   */
  private buildOutboxDedupeKey(input: DispatchEventInput): string {
    const targets = [...input.targetUserIds].sort().join(",");
    return `${input.eventKey}:${input.entityType ?? ""}:${input.entityId ?? ""}:${targets}`;
  }

  emit(input: DispatchEventInput): Promise<DispatchResult> {
    const queued = registerAfterCommit(() =>
      this.emitNow(input).catch((error: unknown) => {
        this.logger.error(
          `notification dispatch failed for ${input.eventKey} in org ${input.orgId}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        );
      }),
    );

    if (!queued) return this.emitNow(input);

    return Promise.resolve({
      eventKey: input.eventKey,
      notified: 0,
      deliveriesQueued: 0,
      suppressed: 0,
      deduped: 0,
      deferred: true,
    });
  }

  /** Cannot borrow the caller's transaction: by the time this runs it has often committed, and the released handle carries no tenant GUC. */
  emitNow(input: DispatchEventInput): Promise<DispatchResult> {
    return runInNewTenantTransaction(this.db, input.orgId, () => this.dispatch(input));
  }

  private async dispatch(input: DispatchEventInput): Promise<DispatchResult> {
    const resolved = await this.registry.resolveDefinition(input.orgId, input.eventKey);
    if (!resolved) throw new BadRequestException(`Unknown notification event: ${input.eventKey}`);
    const { definition, enabled } = resolved;

    const result: DispatchResult = { eventKey: input.eventKey, notified: 0, deliveriesQueued: 0, suppressed: 0, deduped: 0, deferred: false };
    if (!enabled && !definition.mandatory) return result;

    // PIPE-011: never notify someone about their own action. This was a per-caller
    // convention that most callers implemented by hand and some forgot; making it a
    // pipeline rule means it cannot be forgotten. `notifySelf: true` on the input is
    // the explicit opt-out, for the rare event (a security alert about your own
    // session) where self-notification is the point.
    const requested =
      input.actorUserId && input.notifySelf !== true
        ? input.targetUserIds.filter((id) => id !== input.actorUserId)
        : input.targetUserIds;
    if (requested.length === 0) return result;

    const targets = await filterOrgMemberIds(this.db, input.orgId, requested);
    if (targets.length === 0) return result;

    const priority = input.priority ?? definition.defaultPriority;
    const emailRows = await this.db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(inArray(users.id, targets));
    const emailMap = new Map(emailRows.map((r) => [r.id, r.email]));

    // PIPE-014: render in each recipient's own language. One template map per
    // distinct locale in the target set — usually one, never more than a handful.
    const localeRows = await this.db
      .select({ userId: userPreferences.userId, language: userPreferences.language })
      .from(userPreferences)
      .where(inArray(userPreferences.userId, targets));
    const localeByUser = new Map(localeRows.map((r) => [r.userId, r.language]));
    const digestRows = await this.db
      .select({ userId: notificationPreferences.userId, digestMode: notificationPreferences.digestMode })
      .from(notificationPreferences)
      .where(and(eq(notificationPreferences.orgId, input.orgId), inArray(notificationPreferences.userId, targets)));
    const digestModeByUser = new Map(digestRows.map((r) => [r.userId, r.digestMode]));
    const templatesByLocale = new Map<string, TemplateMap>();
    for (const locale of new Set([...targets].map((u) => localeByUser.get(u) ?? "en"))) {
      templatesByLocale.set(
        locale,
        await this.templates.loadTemplates(input.orgId, definition, input.variables ?? {}, locale),
      );
    }

    const routingResults = await this.routing.routeMany(input.orgId, targets, definition, priority);
    const announcements: Array<{ input: AnnounceInput; pushToDevices: boolean }> = [];

    // PIPE-006: this used to be a strictly sequential loop, one transaction per
    // recipient — 50,000 recipients meant 50,000 round trips end to end, and the
    // wall-clock was the sum of every one of them. Recipients are independent (each
    // has its own idempotency key), so they run in bounded waves instead. Bounded,
    // not unbounded: the pool has a finite connection count and an unbounded
    // Promise.all over 50,000 transactions would exhaust it.
    const perRecipient = async (userId: string): Promise<void> => {
      const routingResult = routingResults.get(userId);
      if (!routingResult) return;

      // PIPE-003: re-check object-level visibility immediately before render, per
      // recipient. Membership was checked at enqueue; access can be revoked between
      // enqueue and here, and under queue lag that window widens exactly when the
      // system is busiest. Events with no declared resource kind cost nothing.
      if (definition.visibilityResourceKind) {
        const visible = await this.visibility.canSee(
          definition.visibilityResourceKind,
          input.orgId,
          userId,
          input.entityId,
        );
        if (!visible) {
          result.suppressed += await this.recordAccessSuppression(input, definition, userId, routingResult.priority);
          return;
        }
      }

      // PIPE-008: a channel the user set to DIGEST is accumulated rather than sent.
      // Mandatory events bypass it — a security alert held for a daily digest is not a
      // digest, it is a missed alert.
      const digestWindowMs = definition.mandatory
        ? null
        : NotificationDigestService.windowMsFor(digestModeByUser.get(userId));
      if (digestWindowMs !== null) {
        await this.digest.enqueue({
          orgId: input.orgId,
          userId,
          channel: "EMAIL",
          eventKey: input.eventKey,
          entityType: input.entityType ?? null,
          entityId: input.entityId ?? null,
          title: input.title ?? definition.displayName,
          message: input.message ?? definition.description,
          link: input.link ?? null,
          windowMs: digestWindowMs,
        });
      }

      const perUser = await this.persistForUser(
        input,
        definition,
        userId,
        routingResult,
        emailMap.get(userId) ?? null,
        templatesByLocale.get(localeByUser.get(userId) ?? "en") ?? new Map(),
      );
      result.notified += perUser.createdInApp ? 1 : 0;
      result.deliveriesQueued += perUser.queued;
      result.suppressed += perUser.suppressed;
      result.deduped += perUser.deduped ? 1 : 0;
      if (perUser.announce) announcements.push({ input: perUser.announce, pushToDevices: !perUser.pushHandledByEngine });
    };

    for (let i = 0; i < targets.length; i += FANOUT_CONCURRENCY) {
      await Promise.all(targets.slice(i, i + FANOUT_CONCURRENCY).map(perRecipient));
    }

    await Promise.all(
      announcements.map((a) => this.notificationsService.announce(a.input, a.pushToDevices)),
    );
    return result;
  }

  /**
   * Records that a recipient was withheld for lack of access. Written as a real
   * delivery row so the suppression is auditable and distinguishable from a mute —
   * "we never sent it" and "we sent it and they lost access" are different answers
   * when a customer asks. Uses the same idempotency key as a normal IN_APP delivery,
   * so a replayed dispatch does not double-record.
   */
  private async recordAccessSuppression(
    input: DispatchEventInput,
    definition: NotificationEventDefinition,
    userId: string,
    priority: NotificationPriority,
  ): Promise<number> {
    const [row] = await this.db
      .insert(notificationDeliveries)
      .values({
        orgId: input.orgId,
        userId,
        eventKey: input.eventKey,
        channel: "IN_APP",
        provider: "INTERNAL",
        status: "SUPPRESSED",
        priority,
        suppressionReason: "NO_ACCESS",
        idempotencyKey: this.buildIdempotencyKey(input, userId, "IN_APP", definition.dedupeWindowSeconds),
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
