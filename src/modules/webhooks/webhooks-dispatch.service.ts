import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { webhookEndpoints, webhookLogs } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { checkWebhookUrl } from "../../common/security/ssrf-guard";
import {
  decryptSecret,
  isEncryptedSecret,
} from "../../common/security/secret-encryption.util";
import { WEBHOOK_RESPONSE_BODY_LIMIT } from "./dto/webhook.schemas";
import {
  callProvider,
  type ProviderDescriptor,
  type ProviderCallResult,
} from "../../common/outbound/call-provider";
import { ProviderCircuitBreaker } from "../../common/outbound/provider-circuit-breaker";

const WEBHOOK_TIMEOUT_MS = 10_000;
const WEBHOOK_MAX_ATTEMPTS = 5;
const WEBHOOK_BASE_DELAY_MS = 1_000;
const WEBHOOK_MAX_DELAY_MS = 30_000;

export class WebhookTerminalStatusError extends Error {
  readonly statusCode: number;
  constructor(status: number, body: string) {
    super(`Endpoint responded with ${status}: ${body.slice(0, 200)}`);
    this.statusCode = status;
    this.name = "WebhookTerminalStatusError";
  }
}

export function classifyWebhookError(err: unknown): "terminal" | "retryable" {
  if (err instanceof WebhookTerminalStatusError) return "terminal";
  return "retryable";
}

/**
 * Secrets are encrypted at rest from 2026-08-11. Rows created before that are
 * still plaintext, so read through this rather than assuming either form —
 * signing with the wrong value silently breaks every consumer's verification.
 */
function readSigningSecret(stored: string): string {
  return isEncryptedSecret(stored) ? decryptSecret(stored) : stored;
}

interface DeliveryTarget {
  id: number;
  url: string;
  secret: string;
}

interface FetchedResponse {
  status: number;
  body: string;
}

function logFromResult(
  result: ProviderCallResult<FetchedResponse>,
): { statusCode: number | null; responseBody: string | null; success: boolean } {
  if (result.ok)
    return {
      statusCode: result.value.status,
      responseBody: result.value.body.slice(0, WEBHOOK_RESPONSE_BODY_LIMIT),
      success: true,
    };

  if (result.kind === "terminal") {
    const err = result.error;
    return {
      statusCode: err instanceof WebhookTerminalStatusError ? err.statusCode : null,
      responseBody: err.message.slice(0, WEBHOOK_RESPONSE_BODY_LIMIT),
      success: false,
    };
  }

  if (result.kind === "dead-lettered")
    return {
      statusCode: null,
      responseBody: `Dead after ${result.attempts} attempts: ${result.error.message}`.slice(
        0,
        WEBHOOK_RESPONSE_BODY_LIMIT,
      ),
      success: false,
    };

  return {
    statusCode: null,
    responseBody: `Circuit open for endpoint; retry after ${result.retryAfterMs}ms`,
    success: false,
  };
}

@Injectable()
export class WebhooksDispatchService {
  private readonly breaker = new ProviderCircuitBreaker();

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
    const signature = createHmac("sha256", readSigningSecret(endpoint.secret))
      .update(body)
      .digest("hex");

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

    const descriptor: ProviderDescriptor = {
      provider: `webhook:${endpoint.id}`,
      timeoutMs: WEBHOOK_TIMEOUT_MS,
      maxAttempts: WEBHOOK_MAX_ATTEMPTS,
      baseDelayMs: WEBHOOK_BASE_DELAY_MS,
      maxDelayMs: WEBHOOK_MAX_DELAY_MS,
      classify: classifyWebhookError,
    };

    const result = await callProvider(
      descriptor,
      async () => {
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
        const text = await response.text().catch(() => "");
        if (response.status >= 400 && response.status < 500)
          throw new WebhookTerminalStatusError(response.status, text);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return { status: response.status, body: text };
      },
      this.breaker,
    );

    const { statusCode, responseBody, success } = logFromResult(result);

    await this.db.insert(webhookLogs).values({
      endpointId: endpoint.id,
      orgId,
      event: eventName,
      payload,
      statusCode,
      responseBody,
      attempt: result.attempts,
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
