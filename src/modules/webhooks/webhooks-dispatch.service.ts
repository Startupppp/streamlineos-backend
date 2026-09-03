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
import {
  postSafeWebhook,
  UnsafeWebhookTargetError,
} from "../../common/outbound/safe-webhook-transport";
import { logger } from "../../common/logger/logger.service";
import { registerAfterCommit } from "../../common/tenant";

const WEBHOOK_TIMEOUT_MS = 10_000;
const WEBHOOK_MAX_ATTEMPTS = 5;
const WEBHOOK_BASE_DELAY_MS = 1_000;
const WEBHOOK_MAX_DELAY_MS = 30_000;

/**
 * One chunk is one wave of concurrent outbound calls AND one multi-row
 * webhook_logs insert. 8 caps the sockets an org's fan-out may hold open — each
 * one lives for up to WEBHOOK_MAX_ATTEMPTS x WEBHOOK_TIMEOUT_MS — and caps the
 * insert payload at 8 rows, each carrying a full event payload and a response
 * body already truncated to WEBHOOK_RESPONSE_BODY_LIMIT. Flushing per chunk
 * rather than once at the end keeps the crash window at one chunk.
 */
export const WEBHOOK_DISPATCH_CHUNK = 8;

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
  if (err instanceof UnsafeWebhookTargetError) return "terminal";
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

type DeliveryLogRow = typeof webhookLogs.$inferInsert;

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

  /**
   * Deferred to after-commit, never detached with a bare `void`.
   *
   * A promise detached with `void` inherits the AsyncLocalStorage store it was
   * created in, so `getTenantContext()` keeps answering with the request's
   * context after the handler returned — and `this.db` is the tenant-aware proxy
   * that resolves to `context.tx`. `run()` therefore issued its endpoint read
   * and its `webhook_logs` insert on a transaction whose connection
   * `TenantContextInterceptor` had already committed and released to the pool,
   * up to WEBHOOK_MAX_ATTEMPTS x WEBHOOK_TIMEOUT_MS x chunks later. Best case
   * the write throws and the `.catch` below hides it, so delivery logs go
   * silently missing; worst case it lands on a connection another request has
   * since checked out under a different `app.organization_id` GUC.
   *
   * `registerAfterCommit` returns false when there is no ambient context — a
   * sweep or a consumer — and there the inline run is correct, because there is
   * no request transaction to wait for and dropping the work would lose the
   * webhook. The pattern is `storage.controller.ts:201`.
   */
  dispatch(orgId: string, eventName: string, payload: Record<string, unknown>): void {
    const deliver = (): Promise<void> =>
      this.run(orgId, eventName, payload).catch((error: unknown) => {
        logger.error("[webhooks] dispatch run failed", { orgId, eventName, error });
      });

    if (!registerAfterCommit(deliver)) void deliver();
  }

  private async run(orgId: string, eventName: string, payload: Record<string, unknown>): Promise<void> {
    const endpoints = await this.db
      .select({
        id: webhookEndpoints.id,
        url: webhookEndpoints.url,
        secret: webhookEndpoints.secret,
        events: webhookEndpoints.events,
      })
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.orgId, orgId), eq(webhookEndpoints.isActive, true)));

    const active = endpoints.filter((endpoint) => {
      const events = endpoint.events;
      return events.length === 0 || events.includes(eventName) || events.includes("*");
    });
    if (active.length === 0) return;

    for (let i = 0; i < active.length; i += WEBHOOK_DISPATCH_CHUNK) {
      const chunk = active.slice(i, i + WEBHOOK_DISPATCH_CHUNK);
      const settled = await Promise.allSettled(
        chunk.map((endpoint) => this.deliver(endpoint, orgId, eventName, payload)),
      );
      const rows = settled
        .filter((r): r is PromiseFulfilledResult<DeliveryLogRow> => r.status === "fulfilled")
        .map((r) => r.value);
      for (const rejected of settled)
        if (rejected.status === "rejected")
          logger.error("[webhooks] delivery failed before it could be logged", { orgId, eventName, error: rejected.reason });
      if (rows.length > 0) await this.db.insert(webhookLogs).values(rows);
    }
  }

  private async deliver(
    endpoint: DeliveryTarget,
    orgId: string,
    eventName: string,
    payload: Record<string, unknown>,
  ): Promise<DeliveryLogRow> {
    const body = JSON.stringify({ event: eventName, data: payload, timestamp: new Date().toISOString() });
    const signature = createHmac("sha256", readSigningSecret(endpoint.secret))
      .update(body)
      .digest("hex");

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
        const { statusCode, responseBody } = await postSafeWebhook(
          endpoint.url,
          body,
          {
            "Content-Type": "application/json",
            "X-StreamlineOS-Signature": `sha256=${signature}`,
            "X-Webhook-Event": eventName,
          },
          WEBHOOK_TIMEOUT_MS,
          WEBHOOK_RESPONSE_BODY_LIMIT,
        );
        if (statusCode >= 400 && statusCode < 500)
          throw new WebhookTerminalStatusError(statusCode, responseBody);
        if (statusCode < 200 || statusCode >= 300)
          throw new Error(`HTTP ${statusCode}`);
        return { status: statusCode, body: responseBody };
      },
      this.breaker,
    );

    const { statusCode, responseBody, success } = logFromResult(result);

    return {
      endpointId: endpoint.id,
      orgId,
      event: eventName,
      payload,
      statusCode,
      responseBody,
      attempt: result.attempts,
      success,
    };
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

    const row = await this.deliver(endpoint, orgId, log.event, log.payload ?? {});
    await this.db.insert(webhookLogs).values(row);
    return { success: true };
  }
}
