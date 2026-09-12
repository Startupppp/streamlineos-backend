import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { InboxConsumer } from "../../../common/outbox/inbox-consumer";
import {
  OutboxConsumerRegistry,
  type OutboxEventConsumer,
  type OutboxEventRow,
} from "../../../common/outbox/outbox-consumer.registry";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { AccessService } from "../../access/access.service";
import type { NotificationEventKey } from "../../notifications/notification-events.catalog";
import {
  invAdjustmentApprovalPayloadSchema,
  invLotExpiringPayloadSchema,
  invRecallOpenedPayloadSchema,
} from "./dto/inv-notification-payloads.schema";

/**
 * G3 — the three inventory notifications beyond low stock.
 *
 * Low stock already had this shape (`InvStockLowConsumerService`), and these
 * three are deliberately identical to it rather than clever: claim the event in
 * the inbox so a relay replay does not notify twice, validate the payload, ask
 * `AccessService` who actually holds the permission that makes them the right
 * audience, dispatch, mark processed.
 *
 * **The write never waits for the notifier.** Every one of these is raised by
 * `OutboxWriter.emit` *inside* the transaction that did the work, so the receipt,
 * the adjustment and the recall commit whether or not anything is listening. If
 * the notification side is down the outbox row simply sits there until the relay
 * comes back — which is the difference between a stock system that degrades and
 * one that stops.
 *
 * **Dedupe is per subject, not per event.** The dispatch key is built from the
 * thing being notified about — this lot, this adjustment, this recall — so a
 * sweep that runs hourly and finds the same lot expiring every hour raises one
 * notification, not twenty-four. `notification_outbox` is unique on
 * `(org_id, dedupe_key)`, so that is enforced by the database rather than by
 * remembering to check.
 */

abstract class InventoryNotificationConsumer
  implements OutboxEventConsumer, OnModuleInit
{
  /** The outbox event this consumer claims. Widened to `string` by the registry contract. */
  abstract readonly eventType: string;
  /**
   * The same string, narrowed to the catalog's union.
   *
   * The registry types `eventType` as `string`, and `dispatch.emit` will only
   * accept a key the catalog actually defines — so a consumer written against an
   * event nobody registered fails to compile here rather than dispatching into
   * nothing at runtime.
   */
  protected abstract readonly notificationKey: NotificationEventKey;
  protected abstract readonly consumerName: string;
  protected readonly logger = new Logger(this.constructor.name);

  constructor(
    @Inject(DRIZZLE) protected readonly db: Db,
    protected readonly dispatch: NotificationDispatchService,
    protected readonly registry: OutboxConsumerRegistry,
    protected readonly access: AccessService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  /** What this event means, once its payload is known to be well formed. */
  protected abstract plan(
    payload: unknown,
    orgId: string,
  ): Promise<
    | { kind: "skip"; reason: string }
    | {
        kind: "dispatch";
        permission: string;
        dedupeKey: string;
        entityType: string;
        entityId: string;
        excludeUserId?: string;
      }
  >;

  async handle(event: OutboxEventRow): Promise<void> {
    const inbox = new InboxConsumer(this.db);
    const claimed = await inbox.claim(this.consumerName, {
      eventId: event.eventId,
      organizationId: event.organizationId,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      aggregateVersion: event.aggregateVersion,
    });
    if (!claimed) {
      this.logger.debug(
        `${this.eventType} ${event.eventId} already processed by ${this.consumerName} — skipping`,
      );
      return;
    }

    const orgId = event.organizationId;
    let planned: Awaited<ReturnType<typeof this.plan>>;
    try {
      planned = await this.plan(event.payload, orgId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`${this.eventType} ${event.eventId} could not be planned: ${message}`);
      await inbox.markProcessed(this.consumerName, event.eventId, "FAILED", message);
      return;
    }

    if (planned.kind === "skip") {
      await inbox.markProcessed(this.consumerName, event.eventId, "SKIPPED", planned.reason);
      return;
    }

    const members = await this.access.membersWithPermission(orgId, planned.permission);
    const targetUserIds = members
      .map((m) => m.userId)
      .filter((id) => id !== planned.excludeUserId);

    if (targetUserIds.length === 0) {
      this.logger.debug(
        `${this.eventType} ${event.eventId}: no recipients for org ${orgId} — skipping`,
      );
      await inbox.markProcessed(this.consumerName, event.eventId, "SKIPPED", "no recipients");
      return;
    }

    await this.dispatch.emit({
      orgId,
      dedupeKey: planned.dedupeKey,
      eventKey: this.notificationKey,
      targetUserIds,
      entityType: planned.entityType,
      entityId: planned.entityId,
    });

    await inbox.markProcessed(this.consumerName, event.eventId, "COMPLETED", null);
    this.logger.log(
      `${this.eventType} ${event.eventId}: dispatched to ${targetUserIds.length} recipients for org ${orgId}`,
    );
  }
}

/**
 * A lot crossing a near-expiry window.
 *
 * The dedupe key carries the window, not the sweep run, so a lot that crosses 90
 * days notifies once, goes quiet, and notifies again when it crosses 60 — which
 * is the behaviour a warehouse actually wants from three configured windows, and
 * the reason the window is on the key at all.
 */
@Injectable()
export class InvLotExpiringConsumerService extends InventoryNotificationConsumer {
  readonly eventType = "inventory.lot.expiring";
  protected readonly notificationKey = "inventory.lot.expiring" as const;
  protected readonly consumerName = "inventory:lot-expiring";

  protected async plan(payload: unknown) {
    const parsed = invLotExpiringPayloadSchema.safeParse(payload);
    if (!parsed.success) throw new Error(parsed.error.message);
    const { lotId, windowDays } = parsed.data;
    return {
      kind: "dispatch" as const,
      permission: "inventory:quality:read",
      dedupeKey: `lot-expiring:${lotId}:${windowDays}`,
      entityType: "inv_lot",
      entityId: String(lotId),
    };
  }
}

/**
 * An adjustment waiting for a second signature.
 *
 * The requester is excluded from the audience: they know they raised it, and a
 * notification telling somebody about their own action is the noise that makes
 * people mute a category.
 */
@Injectable()
export class InvAdjustmentApprovalConsumerService extends InventoryNotificationConsumer {
  readonly eventType = "inventory.adjustment.approval_requested";
  protected readonly notificationKey = "inventory.adjustment.approval_requested" as const;
  protected readonly consumerName = "inventory:adjustment-approval";

  protected async plan(payload: unknown) {
    const parsed = invAdjustmentApprovalPayloadSchema.safeParse(payload);
    if (!parsed.success) throw new Error(parsed.error.message);
    const { adjustmentId, requestedByUserId } = parsed.data;
    return {
      kind: "dispatch" as const,
      permission: "inventory:adjustments:approve",
      dedupeKey: `adjustment-approval:${adjustmentId}`,
      entityType: "inv_stock_adjustment",
      entityId: String(adjustmentId),
      excludeUserId: requestedByUserId,
    };
  }
}

/**
 * A recall opened.
 *
 * Everyone who can read quality, not only whoever may execute one: a recall is
 * the event a warehouse most needs to hear about, and the audience for "stop
 * shipping this lot" is wider than the audience for "you may declare a recall".
 */
@Injectable()
export class InvRecallOpenedConsumerService extends InventoryNotificationConsumer {
  readonly eventType = "inventory.recall.opened";
  protected readonly notificationKey = "inventory.recall.opened" as const;
  protected readonly consumerName = "inventory:recall-opened";

  protected async plan(payload: unknown) {
    const parsed = invRecallOpenedPayloadSchema.safeParse(payload);
    if (!parsed.success) throw new Error(parsed.error.message);
    const { recallId } = parsed.data;
    return {
      kind: "dispatch" as const,
      permission: "inventory:quality:read",
      dedupeKey: `recall-opened:${recallId}`,
      entityType: "inv_recall_event",
      entityId: String(recallId),
    };
  }
}
