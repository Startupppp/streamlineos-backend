import { Inject, Injectable } from "@nestjs/common";
import { createHmac, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { projectWebhooks, webhookDeliveries } from "../../db/schema/projects/tasks";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { logger } from "../../common/logger/logger.service";

const WEBHOOK_TIMEOUT_MS = 10_000;
const RESPONSE_BODY_LIMIT = 2000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [5_000, 30_000];

export interface WebhookPayload extends Record<string, unknown> {
  id: number;
  projectId: number;
  actor: string;
  timestamp: string;
}

interface ActiveEndpoint {
  id: number;
  url: string;
  secret: string;
  orgId: string;
}

@Injectable()
export class ProjectsWebhooksDispatchService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  dispatch(orgId: string, projectId: number, eventName: string, payload: WebhookPayload): void {
    void this.run(orgId, projectId, eventName, payload).catch(() => undefined);
  }

  private async run(
    orgId: string,
    projectId: number,
    eventName: string,
    payload: WebhookPayload,
  ): Promise<void> {
    const rows = await this.db
      .select({
        id: projectWebhooks.id,
        url: projectWebhooks.url,
        secret: projectWebhooks.secret,
        orgId: projectWebhooks.orgId,
        events: projectWebhooks.events,
      })
      .from(projectWebhooks)
      .where(
        and(
          eq(projectWebhooks.orgId, orgId),
          eq(projectWebhooks.projectId, projectId),
          eq(projectWebhooks.isActive, true),
        ),
      );

    const active = rows.filter((row) => {
      const events = row.events;
      return events.length === 0 || events.includes(eventName) || events.includes("*");
    });
    if (active.length === 0) return;

    await Promise.allSettled(
      active.map((row) =>
        this.deliverWithRetry(
          { id: row.id, url: row.url, secret: row.secret ?? "", orgId: row.orgId },
          eventName,
          payload,
        ),
      ),
    );
  }

  private async deliverWithRetry(
    endpoint: ActiveEndpoint,
    eventName: string,
    payload: WebhookPayload,
  ): Promise<void> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const success = await this.attempt(endpoint, eventName, payload, attempt);
      if (success) return;
      if (attempt < MAX_ATTEMPTS) {
        const delayMs = RETRY_DELAYS_MS[attempt - 1] ?? 30_000;
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  private async attempt(
    endpoint: ActiveEndpoint,
    eventName: string,
    payload: WebhookPayload,
    attemptNumber: number,
  ): Promise<boolean> {
    const body = JSON.stringify({ event: eventName, data: payload, timestamp: new Date().toISOString() });
    const signature = createHmac("sha256", endpoint.secret || "").update(body).digest("hex");

    let responseCode: number | null = null;
    let responseBody: string | null = null;
    let success = false;
    let lastError: string | null = null;

    try {
      const response = await fetch(endpoint.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-StreamlineOS-Signature": `sha256=${signature}`,
          "X-Webhook-Event": eventName,
        },
        body,
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      responseCode = response.status;
      responseBody = await response.text().catch(() => null);
      success = response.ok;
      if (!success) {
        lastError = `HTTP ${responseCode}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Request failed";
    }

    const nextAttemptAt =
      !success && attemptNumber < MAX_ATTEMPTS
        ? new Date(Date.now() + (RETRY_DELAYS_MS[attemptNumber - 1] ?? 30_000))
        : null;

    try {
      await this.db.insert(webhookDeliveries).values({
        orgId: endpoint.orgId,
        webhookId: endpoint.id,
        event: eventName,
        payload,
        status: success ? "success" : "failed",
        responseCode,
        responseBody: responseBody?.slice(0, RESPONSE_BODY_LIMIT) ?? null,
        attempts: attemptNumber,
        lastError,
        nextAttemptAt,
      });
    } catch (dbError) {
      logger.error("Failed to record webhook delivery", { dbError });
    }

    return success;
  }

  async sendTest(
    orgId: string,
    projectId: number,
    webhookId: number,
  ): Promise<{ success: boolean; responseCode: number | null }> {
    const row = await this.db
      .select({
        id: projectWebhooks.id,
        url: projectWebhooks.url,
        secret: projectWebhooks.secret,
        orgId: projectWebhooks.orgId,
        projectId: projectWebhooks.projectId,
      })
      .from(projectWebhooks)
      .where(
        and(
          eq(projectWebhooks.id, webhookId),
          eq(projectWebhooks.orgId, orgId),
          eq(projectWebhooks.projectId, projectId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]);

    if (!row) return { success: false, responseCode: null };

    const testPayload: WebhookPayload = {
      id: webhookId,
      projectId,
      actor: "system",
      timestamp: new Date().toISOString(),
      message: "This is a test delivery from StreamlineOS.",
    };

    const body = JSON.stringify({
      event: "webhook.test",
      data: testPayload,
      timestamp: new Date().toISOString(),
    });
    const signature = createHmac("sha256", row.secret ?? "").update(body).digest("hex");

    let responseCode: number | null = null;
    let responseBody: string | null = null;
    let success = false;
    let lastError: string | null = null;

    try {
      const response = await fetch(row.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-StreamlineOS-Signature": `sha256=${signature}`,
          "X-Webhook-Event": "webhook.test",
        },
        body,
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      responseCode = response.status;
      responseBody = await response.text().catch(() => null);
      success = response.ok;
      if (!success) {
        lastError = `HTTP ${responseCode}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Request failed";
    }

    await this.db.insert(webhookDeliveries).values({
      orgId,
      webhookId,
      event: "webhook.test",
      payload: testPayload,
      status: success ? "success" : "failed",
      responseCode,
      responseBody: responseBody?.slice(0, RESPONSE_BODY_LIMIT) ?? null,
      attempts: 1,
      lastError,
      nextAttemptAt: null,
    });

    return { success, responseCode };
  }
}

export function generateWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}
