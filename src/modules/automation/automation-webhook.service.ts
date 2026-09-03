import { Inject, Injectable } from "@nestjs/common";
import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { webhookEndpoints, webhookLogs } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { checkWebhookUrl } from "../../common/security/ssrf-guard";
import { type EventPayload } from "./automation.evaluator";

const WEBHOOK_TIMEOUT_MS = 10_000;

@Injectable()
export class AutomationWebhookService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async dispatchWebhook(
    orgId: string,
    eventName: string,
    payload: EventPayload,
  ): Promise<void> {
    /**
     * Projected, not `SELECT *`. The unprojected read pulled every column of
     * every active endpoint — including columns delivery has no use for — into
     * memory on a path that already holds the request's tenant transaction open.
     * The sibling dispatcher reads exactly these four
     * (`webhooks-dispatch.service.ts:127-132`).
     *
     * Deliberately still unbounded. A `LIMIT` here would stop delivering to
     * endpoints an operator configured, without saying so; the real bound
     * belongs on the delivery model, not the read — see
     * `__tests__/automation-webhook-log-durability.spec.ts` for why the fan-out
     * width cannot simply be narrowed while the caller holds a transaction.
     */
    const endpoints = await this.db.query.webhookEndpoints.findMany({
      where: and(eq(webhookEndpoints.orgId, orgId), eq(webhookEndpoints.isActive, true)),
      columns: { id: true, url: true, secret: true, events: true },
    });

    const active = endpoints.filter((endpoint) => {
      const events = endpoint.events;
      return events.length === 0 || events.includes(eventName) || events.includes("*");
    });
    if (active.length === 0) return;

    const results = await Promise.allSettled(
      active.map((endpoint) => this.deliverWebhook(endpoint, orgId, eventName, payload)),
    );

    const failed = results.filter((result) => result.status === "rejected").length;
    if (failed > 0) throw new Error(`Webhook delivery failed for ${failed}/${active.length} endpoint(s)`);
  }

  async deliverWebhook(
    endpoint: { id: number; url: string; secret: string },
    orgId: string,
    eventName: string,
    payload: EventPayload,
  ): Promise<void> {
    const urlCheck = await checkWebhookUrl(endpoint.url);
    if (!urlCheck.allowed) {
      await this.db.insert(webhookLogs).values({
        endpointId: endpoint.id,
        orgId,
        event: eventName,
        payload,
        statusCode: null,
        responseBody: `SSRF: ${urlCheck.reason}`,
        success: false,
      });
      throw new Error(`SSRF: webhook URL blocked (${urlCheck.reason})`);
    }

    const body = JSON.stringify({ event: eventName, data: payload, timestamp: new Date().toISOString() });
    const signature = createHmac("sha256", endpoint.secret).update(body).digest("hex");

    let statusCode: number | null = null;
    let responseBody: string | null;
    let success = false;

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
      responseBody: responseBody?.slice(0, 2000) ?? null,
      success,
    });

    if (!success) throw new Error(`Webhook delivery failed: ${statusCode ?? "no response"}`);
  }
}
