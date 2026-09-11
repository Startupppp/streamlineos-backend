import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { webhookEndpoints, webhookLogs } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { checkWebhookUrl } from "../../common/security/ssrf-guard";
import {
  runInNewTenantTransaction,
  runInTenantTransaction,
} from "../../common/tenant/run-in-tenant-transaction";
import { runOutsideTenantContext } from "../../common/tenant/tenant-context";
import { logSideEffectFailure } from "../../common/logger/side-effect";
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

  /**
   * Fire and forget, but not fail and forget.
   *
   * The work continues after the caller's request has returned, so a failure
   * here has nowhere to be thrown to. It still has somewhere to be *seen*: the
   * previous `.catch(() => undefined)` meant a completely dead outbound webhook
   * system reported nothing to anybody, which is how it stayed dead. A seeded
   * run found every dispatch writing zero rows and every caller being told
   * nothing at all.
   */
  dispatch(orgId: string, eventName: string, payload: Record<string, unknown>): void {
    /**
     * `runOutsideTenantContext` because this work outlives the transaction that
     * started it, and the tenant context does not.
     *
     * The context is async-local, so the continuation inherits whatever
     * transaction was open at the call — which, by the time it runs, has
     * committed and closed. `record` below asks for `runInTenantTransaction`,
     * that helper reuses the ambient it finds, and the insert is then issued
     * against a dead handle: it does not fail, it never settles. A promise that
     * neither resolves nor rejects logs nothing, so a dispatch called from an
     * outbox consumer or a cron sweep silently wrote no delivery row at all.
     *
     * Detaching first means `record` finds no ambient and opens its own, which
     * is what a detached side effect needed all along. `retryLog` does not come
     * through here: it calls `deliver` from inside a live request transaction,
     * and reusing that one is correct.
     */
    void runOutsideTenantContext(() => this.deliverNow(orgId, eventName, payload)).catch(
      logSideEffectFailure("webhook dispatch", { orgId, eventName }),
    );
  }

  /**
   * The same delivery, awaited.
   *
   * `dispatch` is the right shape for a request handler, which has already
   * returned and has nowhere to throw to. It is the wrong shape for a caller
   * that *can* handle a failure — an outbox consumer, for instance, whose whole
   * job is to retry. Handing that caller the fire-and-forget version would mark
   * the event DELIVERED whatever happened here, which is the failure mode the
   * outbox exists to prevent.
   *
   * Identical work either way; only the error handling differs, and only the
   * caller can decide which they need.
   */
  async deliverNow(orgId: string, eventName: string, payload: Record<string, unknown>): Promise<void> {
    /**
     * A tenant transaction of its own, because there is no longer one to
     * borrow.
     *
     * `dispatch` returns immediately and this continues afterwards, so by now
     * the request's transaction has committed and closed. `webhook_endpoints`
     * is behind `tenant_isolation` and the read predicate raises with no tenant
     * context — so this query did not come back empty, it threw, into a
     * `.catch` that discarded it. Short and read-only on purpose: the HTTP
     * calls below must not be made with a database transaction held open.
     */
    const endpoints = await runInNewTenantTransaction(this.db, orgId, (tx) =>
      tx.query.webhookEndpoints.findMany({
        where: and(eq(webhookEndpoints.orgId, orgId), eq(webhookEndpoints.isActive, true)),
      }),
    );

    const active = endpoints.filter((endpoint) => {
      const events = endpoint.events;
      return events.length === 0 || events.includes(eventName) || events.includes("*");
    });
    if (active.length === 0) return;

    /**
     * `allSettled` so one endpoint's failure does not cancel the others — but
     * the results are read, not discarded. Dropping them here reintroduced
     * exactly the fail-and-forget this class was written to end, one level
     * down: a delivery whose own log row could not be written vanished without
     * a trace.
     */
    const settled = await Promise.allSettled(
      active.map((endpoint) => this.deliver(endpoint, orgId, eventName, payload)),
    );
    for (const result of settled) {
      if (result.status === "rejected")
        logSideEffectFailure("webhook delivery", { orgId, eventName })(result.reason);
    }
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
      await this.record(orgId, {
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

    await this.record(orgId, {
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

  /**
   * One log row, in its own short transaction.
   *
   * Deliberately not inside the transaction that read the endpoints: between
   * the two sits an HTTP call with a ten-second timeout, and holding a database
   * connection across it would tie a pool slot to somebody else's server for
   * as long as they cared to be slow. One row per transaction also means a
   * delivery whose log fails cannot take the other endpoints' logs with it.
   *
   * `runInTenantTransaction` rather than `runInNewTenantTransaction`: `retryLog`
   * reaches `deliver` from inside a request that already has a tenant open, and
   * demanding a new one there would refuse the nested transaction outright.
   */
  private async record(
    orgId: string,
    row: typeof webhookLogs.$inferInsert,
  ): Promise<void> {
    await runInTenantTransaction(this.db, (tx) => tx.insert(webhookLogs).values(row).then(() => undefined), {
      orgId,
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
