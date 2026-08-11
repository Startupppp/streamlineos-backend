import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { webhookEndpoints, webhookLogs } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { checkWebhookUrl } from "../../common/security/ssrf-guard";
import { WEBHOOK_RESPONSE_BODY_LIMIT } from "./dto/webhook.schemas";

const WEBHOOK_TIMEOUT_MS = 10_000;

interface DeliveryTarget {
  id: number;
  url: string;
  secret: string;
}

@Injectable()
export class WebhooksDispatchService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  dispatch(orgId: string, eventName: string, payload: Record<string, unknown>): void {
    void this.run(orgId, eventName, payload).catch(() => undefined);
  }

  private async run(orgId: string, eventName: string, payload: Record<string, unknown>): Promise<void> {
    const endpoints = await this.db.query.webhookEndpoints.findMany({
      where: and(eq(webhookEndpoints.orgId, orgId), eq(webhookEndpoints.isActive, true)),
    });

    const active = endpoints.filter((endpoint) => {
      const events = endpoint.events;
      return events.length === 0 || events.includes(eventName) || events.includes("*");
    });
    if (active.length === 0) return;

    await Promise.allSettled(
      active.map((endpoint) => this.deliver(endpoint, orgId, eventName, payload)),
    );
  }

  private async deliver(
    endpoint: DeliveryTarget,
    orgId: string,
    eventName: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const body = JSON.stringify({ event: eventName, data: payload, timestamp: new Date().toISOString() });
    const signature = createHmac("sha256", endpoint.secret).update(body).digest("hex");

    let statusCode: number | null = null;
    let responseBody: string | null;
    let success = false;

    const urlCheck = await checkWebhookUrl(endpoint.url);
    if (!urlCheck.allowed) {
      await this.db.insert(webhookLogs).values({
        endpointId: endpoint.id,
        orgId,
        event: eventName,
        payload,
        statusCode: null,
        responseBody: `Blocked: ${urlCheck.reason}`,
        success: false,
      });
      return;
    }

    try {
      const response = await fetch(endpoint.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-StreamlineOS-Signature": `sha256=${signature}`,
          "X-Webhook-Event": eventName,
        },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      statusCode = response.status;
      responseBody = await response.text().catch(() => null);
      success = response.ok;
    } catch (error) {
      responseBody = error instanceof Error ? error.message : "Request failed";
    }

    await this.db.insert(webhookLogs).values({
      endpointId: endpoint.id,
      orgId,
      event: eventName,
      payload,
      statusCode,
      responseBody: responseBody?.slice(0, WEBHOOK_RESPONSE_BODY_LIMIT) ?? null,
      success,
    });
  }

  async retryLog(orgId: string, endpointId: number, logId: number): Promise<{ success: boolean }> {
    const [endpoint, log] = await Promise.all([
      this.db.query.webhookEndpoints.findFirst({
        where: and(eq(webhookEndpoints.id, endpointId), eq(webhookEndpoints.orgId, orgId)),
      }),
      this.db.query.webhookLogs.findFirst({
        where: and(
          eq(webhookLogs.id, logId),
          eq(webhookLogs.endpointId, endpointId),
          eq(webhookLogs.orgId, orgId),
        ),
      }),
    ]);

    if (!endpoint) throw new NotFoundException("Webhook endpoint not found");
    if (!log) throw new NotFoundException("Delivery log not found");
    if (!endpoint.isActive)
      throw new BadRequestException("Webhook endpoint is inactive; enable it before retrying");
    const retryUrlCheck = await checkWebhookUrl(endpoint.url);
    if (!retryUrlCheck.allowed)
      throw new BadRequestException(
        `Endpoint URL is no longer safe to call: ${retryUrlCheck.reason}`,
      );

    await this.deliver(endpoint, orgId, log.event, log.payload ?? {});
    return { success: true };
  }
}
