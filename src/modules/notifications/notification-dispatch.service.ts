import { Inject, Injectable, BadRequestException } from "@nestjs/common";
import { inArray, eq, and, sql } from "drizzle-orm";
import { notifications, notificationDeliveries, notificationQueue, notificationOutbox, notificationPreferences, userPreferences, users, organizationMembers } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { buildNotifOutboxDedupeKey, buildNotifIdempotencyKey } from "./notification-dispatch-keys";
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
import { getTenantContext, registerAfterCommit } from "../../common/tenant/tenant-context";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { type DbOrTx } from "../../common/rbac/access-invalidate";

type ProviderName = "INTERNAL" | "SMTP" | "WEB_PUSH" | "TWILIO" | "WEBHOOK";

/**
 * PIPE-006. How many recipients are persisted at once. Sized against the Postgres
 * pool rather than the recipient count — higher only queues work inside the driver.
 */
const FANOUT_CONCURRENCY = 10;

/**
 * PIPE-015. Max recipients per outbox row. A large fanout (org-wide announcement)
 * is split into independent outbox rows at write time, so:
 *   – each row is claimed and processed independently (cursor-resumable per chunk)
 *   – the `inArray` filter stays small
 *   – a crash mid-fanout retries only the failing chunk, not the whole send
 */
const OUTBOX_CHUNK = 500;

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
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly registry: NotificationEventRegistryService,
    private readonly routing: NotificationRoutingService,
    private readonly notificationsService: NotificationsService,
    private readonly visibility: NotificationVisibilityRegistry,
    private readonly templates: NotificationTemplateRenderer,
    private readonly digest: NotificationDigestService,
  ) {}

  /**
   * PIPE-001. The one way to emit a notification. Await it: the intent is recorded
   * inside the caller's transaction, so the domain change and the notification commit
   * together or not at all, and a crash cannot lose it.
   *
   * With an ambient tenant transaction it writes the intent and drains it the moment
   * that transaction commits — durable, and no slower than the fire-and-forget hook it
   * replaces. The drain deliberately does not catch: the intent is already committed, so
   * a throw leaves the row PENDING for `NotificationOutboxRelayService` and reaches the
   * interceptor's reportError, where a systematically failing drain stays visible.
   *
   * With no ambient transaction (a background sweep iterating organisations, or a
   * bootstrap path) there is nothing to be atomic with, so it dispatches synchronously
   * in its own tenant transaction and the caller sees the real counts.
   */
  async emit(input: DispatchEventInput): Promise<DispatchResult> {
    const ambient = getTenantContext();
    if (!ambient || ambient.orgId !== input.orgId) return this.emitNow(input);

    const chunks = this.chunkRecipients(input.targetUserIds);
    for (const [i, chunkIds] of chunks.entries()) {
      const chunkInput: DispatchEventInput = { ...input, targetUserIds: chunkIds };
      const dedupeKey = await this.writeIntent(ambient.tx, chunkInput, i > 0 ? i : undefined);
      registerAfterCommit(async () => {
        await this.emitNow({ ...chunkInput, dedupeKey });
        await this.markIntentProcessed(input.orgId, dedupeKey);
      });
    }

    return {
      eventKey: input.eventKey,
      notified: 0,
      deliveriesQueued: 0,
      suppressed: 0,
      deduped: 0,
      deferred: true,
    };
  }

  private chunkRecipients(ids: string[]): string[][] {
    if (ids.length <= OUTBOX_CHUNK) return [ids];
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += OUTBOX_CHUNK)
      chunks.push(ids.slice(i, i + OUTBOX_CHUNK));
    return chunks;
  }

  private async writeIntent(tx: DbOrTx, input: DispatchEventInput, chunkIndex?: number): Promise<string> {
    const baseKey = buildNotifOutboxDedupeKey(input);
    const dedupeKey = chunkIndex !== undefined ? `${baseKey}:c${chunkIndex}` : baseKey;
    await tx
      .insert(notificationOutbox)
      .values({
        orgId: input.orgId,
        eventKey: input.eventKey,
        dedupeKey,
        actorUserId: input.actorUserId ?? null,
        notifySelf: input.notifySelf ?? false,
        targetUserIds: input.targetUserIds,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        title: input.title ?? null,
        message: input.message ?? null,
        link: input.link ?? null,
        variables: (input.variables ?? {}) as Record<string, unknown>,
        metadata: {
          ...(input.metadata ?? {}),
          ...(input.emailHtml ? { emailHtml: input.emailHtml } : {}),
          ...(input.attachments ? { attachments: input.attachments } : {}),
        },
      })
      .onConflictDoNothing({
        target: [notificationOutbox.orgId, notificationOutbox.dedupeKey],
      });
    return dedupeKey;
  }

  /**
   * Opens its own tenant transaction: after-commit hooks run once the request's
   * transaction has already returned, so there is no ambient context and the bare
   * handle carries no tenant GUC — `notification_outbox` is under RLS and would
   * refuse this 42501. Left unmarked the relay re-dispatches, which for an event
   * with no dedupe window is a second notification, not a no-op.
   */
  private markIntentProcessed(orgId: string, dedupeKey: string): Promise<void> {
    return runInNewTenantTransaction(this.db, orgId, async (tx) => {
      await tx
        .update(notificationOutbox)
        .set({ state: "PROCESSED", processedAt: new Date() })
        .where(
          and(eq(notificationOutbox.orgId, orgId), eq(notificationOutbox.dedupeKey, dedupeKey)),
        );
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

    const memberRows = await this.db
      .select({ userId: organizationMembers.userId, id: organizationMembers.id })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, input.orgId), eq(organizationMembers.status, "ACTIVE"), inArray(organizationMembers.userId, targets)));
    const memberIdByUser = new Map(memberRows.map((r) => [r.userId, r.id]));

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

    const routingResults = await this.routing.routeMany(input.orgId, targets, definition, priority, input.channels);
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
          result.suppressed += await this.recordAccessSuppression(input, definition, userId, memberIdByUser.get(userId) ?? null, routingResult.priority);
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
          membershipId: memberIdByUser.get(userId)!,
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
        memberIdByUser.get(userId) ?? null,
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

  private async persistForUser(
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
