import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { hrWebhookDeliveries, hrWebhookSubscriptions } from "../../../../db/schema/hr/webhooks";
import { AuditService } from "../../../../common/audit/audit.service";
import {
  RECRUITMENT_EVENTS,
  type RecruitmentEvent,
} from "../recruitment-webhook-events";
import {
  fieldDocsFor,
  isRecruitmentEvent,
  sandboxBody,
  sandboxSignature,
  samplePayloadFor,
} from "./sandbox-events";

/**
 * The developer-facing half of the ATS webhook: what the five hiring events
 * look like, how to verify a signature, and a way to fire one on demand.
 *
 * Separate from `HrWebhooksService`, which owns subscription CRUD and delivery.
 * This service adds nothing to that lifecycle — it reads it and queues one
 * delivery through it — because a second writer to the same two tables is how
 * the retry sweep and the test button came to disagree in the first place.
 */
@Injectable()
export class AtsSandboxService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  /**
   * The catalogue, with a worked example per event.
   *
   * The example is signed with a published secret so a developer can run their
   * own verification against a known-good pair before any real delivery
   * arrives — otherwise the first thing they debug is a signature mismatch with
   * nothing to compare against.
   */
  catalogue() {
    const at = new Date("2026-01-01T00:00:00.000Z");
    return {
      signatureHeader: "X-StreamlineOS-Signature",
      eventHeader: "X-Webhook-Event",
      timestampHeader: "X-Webhook-Timestamp",
      algorithm: "HMAC-SHA256 over the raw request body, hex, prefixed 'sha256='",
      events: RECRUITMENT_EVENTS.map((event) => {
        const payload = samplePayloadFor(event);
        const body = sandboxBody(event, payload, at);
        return {
          value: event,
          fields: fieldDocsFor(event),
          samplePayload: payload,
          /*
            A fixed, obviously-fake secret. It is in the response on purpose:
            the pair below is only useful if the reader can reproduce it, and
            publishing a constant that signs nothing real is safer than
            tempting somebody to test with their own live secret.
          */
          exampleSecret: SANDBOX_EXAMPLE_SECRET,
          exampleBody: body,
          exampleSignature: sandboxSignature(SANDBOX_EXAMPLE_SECRET, body),
        };
      }),
    };
  }

  /**
   * Fires one hiring event's sample payload at a subscription the tenant owns.
   *
   * Refuses an event the subscription is not subscribed to. Firing one anyway
   * would tell the developer their receiver works for an event that will never
   * reach it, which is worse than refusing — an empty `events` list means "all"
   * on the dispatch path, and is honoured as "all" here too.
   */
  async replay(orgId: string, userId: string, subscriptionId: number, event: RecruitmentEvent) {
    if (!isRecruitmentEvent(event)) {
      throw new BadRequestException("Not a hiring event.");
    }

    const subscription = await this.db.query.hrWebhookSubscriptions.findFirst({
      where: and(
        eq(hrWebhookSubscriptions.orgId, orgId),
        eq(hrWebhookSubscriptions.id, subscriptionId),
        isNull(hrWebhookSubscriptions.deletedAt),
      ),
      columns: { id: true, events: true, isActive: true },
    });
    if (!subscription) throw new NotFoundException("Webhook subscription not found.");

    if (!subscription.isActive) {
      throw new BadRequestException("That webhook is switched off. Enable it before replaying.");
    }
    const subscribed = subscription.events.length === 0 || subscription.events.includes(event);
    if (!subscribed) {
      throw new BadRequestException(
        `That webhook is not subscribed to ${event}, so a replay would prove nothing. Add the event first.`,
      );
    }

    const payload = samplePayloadFor(event);
    const [delivery] = await this.db
      .insert(hrWebhookDeliveries)
      .values({
        orgId,
        subscriptionId,
        event,
        /*
          Marked in the payload rather than in a column. The receiver has to be
          able to tell a replay from a real hire before it acts on it, and a
          flag only we can see would not do that. `hr_webhook_deliveries` also
          has no spare column and this is not worth a migration.
        */
        payload: { ...payload, replay: true },
        status: "pending",
        attempts: 0,
      })
      .returning({ id: hrWebhookDeliveries.id });
    if (!delivery) throw new BadRequestException("Could not queue the replay.");

    await this.audit.logCritical({
      action: "ATS_WEBHOOK_REPLAY",
      userId,
      orgId,
      targetId: String(subscriptionId),
      targetType: "hr_webhook_subscription",
      metadata: { event, deliveryId: delivery.id },
    });

    /*
      Queued, not sent. `HrWebhooksService.retryPending` is the one sender, and
      calling `fetch` from here would be the second writer this service exists
      to avoid — as well as an outbound call holding a request connection.
    */
    return {
      deliveryId: delivery.id,
      event,
      queued: true,
      note: "Queued. The delivery sweep will send it and record the response.",
    };
  }

  /**
   * The exact bytes and signature sent for one delivery, so a developer can
   * reproduce the HMAC on their side.
   *
   * The secret is never returned — the signature is, which is what the receiver
   * already has, and the body, which the receiver already had. Neither
   * discloses anything a valid receiver did not hold; the secret would.
   */
  async signatureFor(orgId: string, subscriptionId: number, deliveryId: number) {
    const [row] = await this.db
      .select({
        id: hrWebhookDeliveries.id,
        event: hrWebhookDeliveries.event,
        payload: hrWebhookDeliveries.payload,
        status: hrWebhookDeliveries.status,
        attempts: hrWebhookDeliveries.attempts,
        responseStatus: hrWebhookDeliveries.responseStatus,
        error: hrWebhookDeliveries.error,
        createdAt: hrWebhookDeliveries.createdAt,
        lastAttemptAt: hrWebhookDeliveries.lastAttemptAt,
        secret: hrWebhookSubscriptions.secret,
      })
      .from(hrWebhookDeliveries)
      .innerJoin(
        hrWebhookSubscriptions,
        and(
          eq(hrWebhookSubscriptions.orgId, hrWebhookDeliveries.orgId),
          eq(hrWebhookSubscriptions.id, hrWebhookDeliveries.subscriptionId),
        ),
      )
      .where(
        and(
          eq(hrWebhookDeliveries.orgId, orgId),
          eq(hrWebhookDeliveries.id, deliveryId),
          eq(hrWebhookDeliveries.subscriptionId, subscriptionId),
          isNull(hrWebhookSubscriptions.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException("Delivery not found.");

    /*
      The timestamp is regenerated, so this body is the SHAPE that was sent
      rather than the byte-identical original — `hr_webhook_deliveries` stores
      no timestamp for the attempt. Said plainly in the response rather than
      left for a developer to discover when their hash does not match.
    */
    const at = row.lastAttemptAt ?? row.createdAt;
    const body = sandboxBody(row.event as RecruitmentEvent, row.payload, at);

    return {
      deliveryId: row.id,
      event: row.event,
      status: row.status,
      attempts: row.attempts,
      responseStatus: row.responseStatus,
      error: row.error,
      signedBody: body,
      signature: sandboxSignature(row.secret, body),
      caveat:
        "The timestamp here is the recorded attempt time. If your receiver hashed a different timestamp the signatures will differ — compare the payload, not the bytes.",
    };
  }

  /** Recent hiring deliveries across every subscription, newest first. */
  async recentDeliveries(orgId: string, limit: number) {
    const rows = await this.db
      .select({
        deliveryId: hrWebhookDeliveries.id,
        subscriptionId: hrWebhookDeliveries.subscriptionId,
        subscriptionName: hrWebhookSubscriptions.name,
        event: hrWebhookDeliveries.event,
        status: hrWebhookDeliveries.status,
        attempts: hrWebhookDeliveries.attempts,
        responseStatus: hrWebhookDeliveries.responseStatus,
        error: hrWebhookDeliveries.error,
        createdAt: hrWebhookDeliveries.createdAt,
      })
      .from(hrWebhookDeliveries)
      .innerJoin(
        hrWebhookSubscriptions,
        and(
          eq(hrWebhookSubscriptions.orgId, hrWebhookDeliveries.orgId),
          eq(hrWebhookSubscriptions.id, hrWebhookDeliveries.subscriptionId),
        ),
      )
      .where(eq(hrWebhookDeliveries.orgId, orgId))
      .orderBy(desc(hrWebhookDeliveries.createdAt), desc(hrWebhookDeliveries.id))
      .limit(Math.min(Math.max(limit, 1), 100));

    /*
      Filtered here rather than in SQL: `event` is free text on this table and
      an `inArray` of five literals would still scan, while the list is capped
      at 100 rows before it reaches this line.
    */
    return rows.filter((row) => isRecruitmentEvent(row.event));
  }
}

/**
 * The published example secret. Obviously not a credential — it exists so the
 * documented body/signature pair can be reproduced by hand.
 */
export const SANDBOX_EXAMPLE_SECRET = "whsec_example_do_not_use_in_production";
