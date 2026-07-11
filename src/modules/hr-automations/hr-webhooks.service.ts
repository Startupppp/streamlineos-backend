import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { createHmac, randomBytes } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { hrWebhookSubscriptions, hrWebhookDeliveries } from "../../db/schema/hr/webhooks";
import { logger } from "../../common/logger/logger.service";
import { HR_EVENT_SAMPLE_PAYLOADS, HR_AUTOMATION_EVENTS, HR_EVENT_FIELD_DOCS } from "./hr-automation-events";
import type { HrAutomationEvent } from "./hr-automation-events";
import type {
  CreateHrWebhookInput,
  UpdateHrWebhookInput,
  ListDeliveriesInput,
} from "./dto/hr-webhook.schemas";

const WEBHOOK_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 5;
const PRIVATE_IP_PATTERN = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|::1|localhost)/i;

function buildSignature(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function backoffMs(attempt: number): number {
  return Math.min(60 * 60_000, Math.pow(2, attempt) * 60_000);
}

@Injectable()
export class HrWebhooksService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listSubscriptions(orgId: string, page: number, limit: number) {
    const offset = (page - 1) * limit;
    const rows = await this.db.query.hrWebhookSubscriptions.findMany({
      where: and(
        eq(hrWebhookSubscriptions.orgId, orgId),
        isNull(hrWebhookSubscriptions.deletedAt),
      ),
      orderBy: [desc(hrWebhookSubscriptions.createdAt)],
      limit,
      offset,
      columns: { secret: false },
    });
    return rows;
  }

  async getSubscription(orgId: string, id: number) {
    const row = await this.db.query.hrWebhookSubscriptions.findFirst({
      where: and(
        eq(hrWebhookSubscriptions.id, id),
        eq(hrWebhookSubscriptions.orgId, orgId),
        isNull(hrWebhookSubscriptions.deletedAt),
      ),
      columns: { secret: false },
    });
    if (!row) throw new NotFoundException("Webhook subscription not found");
    return row;
  }

  async createSubscription(orgId: string, userId: string, input: CreateHrWebhookInput) {
    this.assertSsrfSafe(input.url);
    const secret = randomBytes(32).toString("hex");
    try {
      const [row] = await this.db
        .insert(hrWebhookSubscriptions)
        .values({
          orgId,
          name: input.name,
          url: input.url,
          secret,
          events: input.events,
          isActive: input.isActive,
          createdBy: userId,
        })
        .returning();
      return { ...row, secret };
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("23505")) {
        throw new ConflictException(`A webhook named "${input.name}" already exists`);
      }
      throw err;
    }
  }

  async updateSubscription(orgId: string, id: number, input: UpdateHrWebhookInput) {
    if (input.url) this.assertSsrfSafe(input.url);
    try {
      const [updated] = await this.db
        .update(hrWebhookSubscriptions)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.url !== undefined ? { url: input.url } : {}),
          ...(input.events !== undefined ? { events: input.events } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(hrWebhookSubscriptions.id, id),
            eq(hrWebhookSubscriptions.orgId, orgId),
            isNull(hrWebhookSubscriptions.deletedAt),
          ),
        )
        .returning({ id: hrWebhookSubscriptions.id });
      if (!updated) throw new NotFoundException("Webhook subscription not found");
      return this.getSubscription(orgId, id);
    } catch (err: unknown) {
      if (err instanceof ConflictException || err instanceof NotFoundException) throw err;
      if (err instanceof Error && err.message.includes("23505")) {
        throw new ConflictException("A webhook with that name already exists");
      }
      throw err;
    }
  }

  async deleteSubscription(orgId: string, id: number) {
    const [deleted] = await this.db
      .update(hrWebhookSubscriptions)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(hrWebhookSubscriptions.id, id),
          eq(hrWebhookSubscriptions.orgId, orgId),
          isNull(hrWebhookSubscriptions.deletedAt),
        ),
      )
      .returning({ id: hrWebhookSubscriptions.id });
    if (!deleted) throw new NotFoundException("Webhook subscription not found");
    return { success: true };
  }

  async listDeliveries(orgId: string, subscriptionId: number, params: ListDeliveriesInput) {
    await this.getSubscription(orgId, subscriptionId);
    const offset = (params.page - 1) * params.limit;
    return this.db.query.hrWebhookDeliveries.findMany({
      where: and(
        eq(hrWebhookDeliveries.orgId, orgId),
        eq(hrWebhookDeliveries.subscriptionId, subscriptionId),
      ),
      orderBy: [desc(hrWebhookDeliveries.createdAt)],
      limit: params.limit,
      offset,
    });
  }

  getEvents() {
    return {
      events: HR_AUTOMATION_EVENTS.map((event) => ({
        value: event,
        fields: HR_EVENT_FIELD_DOCS[event],
        samplePayload: HR_EVENT_SAMPLE_PAYLOADS[event],
      })),
    };
  }

  async testSubscription(orgId: string, subscriptionId: number) {
    const sub = await this.db.query.hrWebhookSubscriptions.findFirst({
      where: and(
        eq(hrWebhookSubscriptions.id, subscriptionId),
        eq(hrWebhookSubscriptions.orgId, orgId),
        isNull(hrWebhookSubscriptions.deletedAt),
      ),
    });
    if (!sub) throw new NotFoundException("Webhook subscription not found");

    const sampleEvent: HrAutomationEvent = (sub.events[0] as HrAutomationEvent | undefined) ?? "employee.created";
    const payload = HR_EVENT_SAMPLE_PAYLOADS[sampleEvent] ?? {};

    const [delivery] = await this.db
      .insert(hrWebhookDeliveries)
      .values({
        orgId,
        subscriptionId,
        event: sampleEvent,
        payload,
        status: "pending",
        attempts: 0,
      })
      .returning();

    void this.attemptDelivery(sub.id, sub.url, sub.secret, delivery.id, sampleEvent, payload, 0);
    return { deliveryId: delivery.id, event: sampleEvent };
  }

  async redeliver(orgId: string, subscriptionId: number, deliveryId: number) {
    await this.getSubscription(orgId, subscriptionId);
    const delivery = await this.db.query.hrWebhookDeliveries.findFirst({
      where: and(
        eq(hrWebhookDeliveries.id, deliveryId),
        eq(hrWebhookDeliveries.subscriptionId, subscriptionId),
        eq(hrWebhookDeliveries.orgId, orgId),
      ),
    });
    if (!delivery) throw new NotFoundException("Delivery not found");

    const sub = await this.db.query.hrWebhookSubscriptions.findFirst({
      where: eq(hrWebhookSubscriptions.id, subscriptionId),
    });
    if (!sub) throw new NotFoundException("Webhook subscription not found");

    await this.db
      .update(hrWebhookDeliveries)
      .set({ status: "pending", attempts: 0, error: null, lastAttemptAt: null })
      .where(eq(hrWebhookDeliveries.id, deliveryId));

    void this.attemptDelivery(
      sub.id,
      sub.url,
      sub.secret,
      deliveryId,
      delivery.event as HrAutomationEvent,
      delivery.payload,
      0,
    );
    return { success: true };
  }

  dispatch(orgId: string, event: HrAutomationEvent, payload: Record<string, unknown>): void {
    void this.run(orgId, event, payload).catch((err) => {
      logger.error("hr-webhooks dispatch failed", { orgId, event, err });
    });
  }

  private async run(
    orgId: string,
    event: HrAutomationEvent,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const subs = await this.db.query.hrWebhookSubscriptions.findMany({
      where: and(
        eq(hrWebhookSubscriptions.orgId, orgId),
        eq(hrWebhookSubscriptions.isActive, true),
        isNull(hrWebhookSubscriptions.deletedAt),
      ),
    });

    const active = subs.filter((s) => s.events.length === 0 || s.events.includes(event));
    if (active.length === 0) return;

    const insertedDeliveries = await this.db
      .insert(hrWebhookDeliveries)
      .values(
        active.map((s) => ({
          orgId,
          subscriptionId: s.id,
          event,
          payload,
          status: "pending" as const,
          attempts: 0,
        })),
      )
      .returning();

    await Promise.allSettled(
      insertedDeliveries.map((delivery, i) => {
        const sub = active[i];
        if (!sub) return Promise.resolve();
        return this.attemptDelivery(sub.id, sub.url, sub.secret, delivery.id, event, payload, 0);
      }),
    );
  }

  private async attemptDelivery(
    subscriptionId: number,
    url: string,
    secret: string,
    deliveryId: number,
    event: HrAutomationEvent,
    payload: Record<string, unknown>,
    currentAttempts: number,
  ): Promise<void> {
    const timestamp = new Date().toISOString();
    const body = JSON.stringify({ event, data: payload, timestamp });
    const signature = buildSignature(secret, body);

    let responseStatus: number | null = null;
    let error: string | null = null;
    let success = false;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-StreamlineOS-Signature": signature,
          "X-Webhook-Event": event,
          "X-Webhook-Timestamp": timestamp,
        },
        body,
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      responseStatus = response.status;
      success = response.ok;
      if (!response.ok) error = `HTTP ${response.status}`;
    } catch (err) {
      error = err instanceof Error ? err.message : "Request failed";
    }

    const newAttempts = currentAttempts + 1;

    if (success) {
      await this.db
        .update(hrWebhookDeliveries)
        .set({
          status: "delivered",
          attempts: newAttempts,
          lastAttemptAt: new Date(),
          responseStatus,
          error: null,
        })
        .where(eq(hrWebhookDeliveries.id, deliveryId));
      return;
    }

    const isDead = newAttempts >= MAX_ATTEMPTS;
    await this.db
      .update(hrWebhookDeliveries)
      .set({
        status: isDead ? "dead" : "failed",
        attempts: newAttempts,
        lastAttemptAt: new Date(),
        responseStatus,
        error,
      })
      .where(eq(hrWebhookDeliveries.id, deliveryId));

    logger.warn("hr-webhook delivery failed", {
      subscriptionId,
      deliveryId,
      attempts: newAttempts,
      error,
    });
  }

  async retryPending(): Promise<void> {
    const now = new Date();

    const pending = await this.db.query.hrWebhookDeliveries.findMany({
      where: and(
        inArray(hrWebhookDeliveries.status, ["pending", "failed"]),
        lt(hrWebhookDeliveries.attempts, MAX_ATTEMPTS),
      ),
      orderBy: [asc(hrWebhookDeliveries.createdAt)],
      limit: 100,
    });

    const eligible = pending.filter((d) => {
      if (d.attempts === 0) return true;
      const next = new Date((d.lastAttemptAt?.getTime() ?? 0) + backoffMs(d.attempts));
      return now >= next;
    });

    if (eligible.length === 0) return;

    const subIds = [...new Set(eligible.map((d) => d.subscriptionId))];
    const subs = await this.db.query.hrWebhookSubscriptions.findMany({
      where: and(
        inArray(hrWebhookSubscriptions.id, subIds),
        isNull(hrWebhookSubscriptions.deletedAt),
      ),
    });
    const subMap = new Map(subs.map((s) => [s.id, s]));

    await Promise.allSettled(
      eligible.map((d) => {
        const sub = subMap.get(d.subscriptionId);
        if (!sub) return Promise.resolve();
        return this.attemptDelivery(
          sub.id,
          sub.url,
          sub.secret,
          d.id,
          d.event as HrAutomationEvent,
          d.payload,
          d.attempts,
        );
      }),
    );

    await this.db
      .update(hrWebhookDeliveries)
      .set({ status: "dead" })
      .where(
        and(
          inArray(hrWebhookDeliveries.status, ["failed"]),
          sql`${hrWebhookDeliveries.attempts} >= ${MAX_ATTEMPTS}`,
        ),
      );
  }

  private assertSsrfSafe(url: string): void {
    try {
      const parsed = new URL(url);
      if (PRIVATE_IP_PATTERN.test(parsed.hostname)) {
        throw new ConflictException("SSRF: private/internal URLs are not allowed");
      }
    } catch (err) {
      if (err instanceof ConflictException) throw err;
      throw new ConflictException("Invalid URL");
    }
  }
}
