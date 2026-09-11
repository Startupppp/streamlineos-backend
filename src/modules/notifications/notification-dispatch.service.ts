import { Inject, Injectable, Logger, BadRequestException } from "@nestjs/common";
import { inArray, eq, and } from "drizzle-orm";
import { notificationOutbox, notificationPreferences, userPreferences, users, organizationMembers } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { buildNotifOutboxDedupeKey, buildNotifIdempotencyKey } from "./notification-dispatch-keys";
import { NotificationEventRegistryService } from "./notification-event-registry.service";
import { NotificationRoutingService } from "./notification-routing.service";
import { NotificationsService, type AnnounceInput } from "./notifications.service";
import { NotificationVisibilityRegistry } from "./notification-visibility.registry";
import { NotificationTemplateRenderer, type TemplateMap } from "./notification-template-renderer.service";
import { NotificationDigestService } from "./notification-digest.service";
import { NotificationDispatchPersistenceService } from "./notification-dispatch-persistence.service";
import type { DispatchEventInput } from "./notification.types";
import { filterOrgMemberIds } from "../../common/tenant/org-membership";
import { getTenantContext, registerAfterCommit } from "../../common/tenant/tenant-context";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";

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

export interface DispatchResult {
  eventKey: string;
  notified: number;
  deliveriesQueued: number;
  suppressed: number;
  deduped: number;
  deferred: boolean;
  /**
   * Recipients whose own materialisation threw. Counted rather than thrown so one
   * bad recipient cannot cost the other 499 theirs — see `perRecipient`.
   */
  failedRecipients: number;
}

@Injectable()
export class NotificationDispatchService {
  private readonly logger = new Logger(NotificationDispatchService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly registry: NotificationEventRegistryService,
    private readonly routing: NotificationRoutingService,
    private readonly notificationsService: NotificationsService,
    private readonly visibility: NotificationVisibilityRegistry,
    private readonly templates: NotificationTemplateRenderer,
    private readonly digest: NotificationDigestService,
    private readonly persistence: NotificationDispatchPersistenceService,
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
    const chunkData = chunks.map((chunkIds, i) => {
      const chunkInput: DispatchEventInput = { ...input, targetUserIds: chunkIds };
      const baseKey = buildNotifOutboxDedupeKey(chunkInput);
      const dedupeKey = i > 0 ? `${baseKey}:c${i}` : baseKey;
      return { chunkInput, dedupeKey };
    });

    await ambient.tx
      .insert(notificationOutbox)
      .values(
        chunkData.map(({ chunkInput, dedupeKey }) => ({
          orgId: chunkInput.orgId,
          eventKey: chunkInput.eventKey,
          dedupeKey,
          actorUserId: chunkInput.actorUserId ?? null,
          notifySelf: chunkInput.notifySelf ?? false,
          targetUserIds: chunkInput.targetUserIds,
          entityType: chunkInput.entityType ?? null,
          entityId: chunkInput.entityId ?? null,
          title: chunkInput.title ?? null,
          message: chunkInput.message ?? null,
          link: chunkInput.link ?? null,
          variables: chunkInput.variables ?? {},
          metadata: {
            ...(chunkInput.metadata ?? {}),
            ...(chunkInput.emailHtml ? { emailHtml: chunkInput.emailHtml } : {}),
            ...(chunkInput.attachments ? { attachments: chunkInput.attachments } : {}),
          },
        })),
      )
      .onConflictDoNothing({
        target: [notificationOutbox.orgId, notificationOutbox.dedupeKey],
      });

    for (const { chunkInput, dedupeKey } of chunkData) {
      registerAfterCommit(async () => {
        // `replayKey`, not `dedupeKey`: this is the outbox row's identity, and passing
        // it as a caller dedupe key is what overrode the event's declared window.
        await this.emitNow({ ...chunkInput, replayKey: dedupeKey });
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
      // Zero because nothing has been materialised yet, not because nothing failed:
      // every recipient on this path is dispatched from the after-commit hook above,
      // so failures are counted by that run's own result, never by this one.
      failedRecipients: 0,
    };
  }

  private chunkRecipients(ids: string[]): string[][] {
    if (ids.length <= OUTBOX_CHUNK) return [ids];
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += OUTBOX_CHUNK)
      chunks.push(ids.slice(i, i + OUTBOX_CHUNK));
    return chunks;
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

    const result: DispatchResult = { eventKey: input.eventKey, notified: 0, deliveriesQueued: 0, suppressed: 0, deduped: 0, deferred: false, failedRecipients: 0 };
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
          result.suppressed += await this.persistence.recordAccessSuppression(input, definition, userId, memberIdByUser.get(userId) ?? null, routingResult.priority);
          return;
        }
      }

      // PIPE-008: a channel the user set to DIGEST is accumulated rather than sent.
      // Mandatory events bypass it — a security alert held for a daily digest is not a
      // digest, it is a missed alert.
      const digestWindowMs = definition.mandatory
        ? null
        : NotificationDigestService.windowMsFor(digestModeByUser.get(userId));
      const membershipId = memberIdByUser.get(userId);
      if (digestWindowMs !== null && membershipId !== undefined) {
        await this.digest.enqueue({
          orgId: input.orgId,
          membershipId,
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

      const perUser = await this.persistence.persistForUser(
        input,
        definition,
        userId,
        membershipId ?? null,
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

    /**
     * The comment above says recipients are independent; before this they were not
     * ISOLATED. `perRecipient` had no try/catch, so one recipient's failure rejected
     * the whole `Promise.all`, threw out of `dispatch`, rolled the tenant transaction
     * back and let the relay increment `attempt_count`. A deterministically bad
     * recipient — a missing membership row, a template that throws on their locale —
     * therefore burned all five attempts and DEADed the chunk, and 499 people never
     * got the notification because of the 500th.
     *
     * Counted, never swallowed: a deferred failure that logs nothing is how the last
     * notification outage stayed invisible for the life of the product.
     *
     * What this does NOT fix, stated so nobody reads more into it: the ten waves run
     * as concurrent nested savepoints on ONE connection (`createTenantAwareDb`
     * resolves `this.db` to the ambient transaction), so a `rollback to s<n>` still
     * discards the savepoints opened after it and can take its wave-mates with it.
     * The blast radius drops from the whole chunk to at most one wave of
     * FANOUT_CONCURRENCY; closing it entirely means a top-level transaction per
     * recipient, which trades this for pool exhaustion and needs its own measurement.
     */
    const perRecipientIsolated = async (userId: string): Promise<void> => {
      try {
        await perRecipient(userId);
      } catch (error: unknown) {
        result.failedRecipients += 1;
        this.logger.error(
          `notification fanout failed for recipient ${userId} (${input.eventKey}, org ${input.orgId}): ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        );
      }
    };

    for (let i = 0; i < targets.length; i += FANOUT_CONCURRENCY) {
      await Promise.all(targets.slice(i, i + FANOUT_CONCURRENCY).map(perRecipientIsolated));
    }

    await Promise.all(
      announcements.map((a) => this.notificationsService.announce(a.input, a.pushToDevices)),
    );
    return result;
  }
}
