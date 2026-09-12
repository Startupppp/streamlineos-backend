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
import { registerAfterCommit, runOutsideTenantContext } from "../../common/tenant/tenant-context";
import { logger } from "../../common/logger/logger.service";
import { callProvider } from "../../common/outbound/call-provider";
import { ProviderCircuitBreaker } from "../../common/outbound/provider-circuit-breaker";
import { postSafeWebhook } from "../../common/outbound/safe-webhook-transport";
import { WEBHOOK_RESPONSE_BODY_LIMIT } from "./dto/webhook.schemas";
import {
  WEBHOOK_TIMEOUT_MS,
  WebhookTerminalStatusError,
  logFromResult,
  readSigningSecret,
  webhookDescriptor,
  type DeliveryTarget,
} from "./lib/webhook-delivery";

export { WebhookTerminalStatusError, classifyWebhookError } from "./lib/webhook-delivery";

/**
 * One chunk is one wave of concurrent outbound calls AND one multi-row
 * webhook_logs insert. 8 caps the sockets an org's fan-out may hold open — each
 * one lives for up to the attempt budget x WEBHOOK_TIMEOUT_MS — and caps the
 * insert payload at 8 rows, each carrying a full event payload and a response
 * body already truncated to WEBHOOK_RESPONSE_BODY_LIMIT. Flushing per chunk
 * rather than once at the end keeps the crash window at one chunk.
 */
export const WEBHOOK_DISPATCH_CHUNK = 8;

type DeliveryLogRow = typeof webhookLogs.$inferInsert;

@Injectable()
export class WebhooksDispatchService {
  private readonly breaker = new ProviderCircuitBreaker();

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * Fire and forget, but not fail and forget — and not before the commit.
   *
   * The work continues after the caller's request has returned, so a failure
   * here has nowhere to be thrown to. It still has somewhere to be *seen*: the
   * previous `.catch(() => undefined)` meant a completely dead outbound webhook
   * system reported nothing to anybody, which is how it stayed dead.
   *
   * `registerAfterCommit` so a webhook never announces work whose transaction
   * then rolled back. It returns false when there is no ambient context — a
   * sweep or a consumer — and there the inline run is correct, because there is
   * no request transaction to wait for and dropping the work would lose the
   * webhook.
   *
   * `runOutsideTenantContext` because the tenant context is async-local and
   * the continuation would otherwise inherit a transaction that has committed
   * and closed. `deliverNow` then finds no ambient and opens its own, which is
   * what a detached side effect needed all along. `retryLog` does not come
   * through here: it calls `deliver` from inside a live request transaction,
   * and reusing that one is correct.
   */
  dispatch(orgId: string, eventName: string, payload: Record<string, unknown>): void {
    const deliver = (): Promise<void> =>
      runOutsideTenantContext(() => this.deliverNow(orgId, eventName, payload)).catch(
        (error: unknown) => {
          logger.error("[webhooks] dispatch run failed", { orgId, eventName, error });
        },
      );

    if (!registerAfterCommit(deliver)) void deliver();
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
     * borrow. `webhook_endpoints` is behind `tenant_isolation` and the read
     * predicate raises with no tenant context. Short and read-only on purpose:
     * the HTTP calls below must not be made with a database transaction held
     * open. Only the four columns delivery needs, never the whole row.
     */
    const endpoints = await runInNewTenantTransaction(this.db, orgId, (tx) =>
      tx
        .select({
          id: webhookEndpoints.id,
          url: webhookEndpoints.url,
          secret: webhookEndpoints.secret,
          events: webhookEndpoints.events,
        })
        .from(webhookEndpoints)
        .where(and(eq(webhookEndpoints.orgId, orgId), eq(webhookEndpoints.isActive, true))),
    );

    const active = endpoints.filter((endpoint) => {
      const events = endpoint.events;
      return events.length === 0 || events.includes(eventName) || events.includes("*");
    });
    if (active.length === 0) return;

    /**
     * Bounded waves, one log insert per wave. `allSettled` so one endpoint's
     * failure does not cancel the others — but the results are read, not
     * discarded: a delivery that failed before it produced a log row is logged
     * here instead of vanishing.
     */
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
          logger.error("[webhooks] delivery failed before it could be logged", {
            orgId,
            eventName,
            error: rejected.reason,
          });
      if (rows.length > 0) await this.record(orgId, rows);
    }
  }

  /**
   * One endpoint, one signed POST through the pinned-DNS transport, and the log
   * row it earned. The transport resolves the host once and connects to that
   * address, refusing a private or blocked one with `UnsafeWebhookTargetError`
   * — which `classifyWebhookError` treats as terminal — so the SSRF check and
   * the connection can no longer see two different answers.
   */
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

    const result = await callProvider(
      webhookDescriptor(endpoint.id),
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

  /**
   * One wave's log rows, in their own short transaction.
   *
   * Deliberately not inside the transaction that read the endpoints: between
   * the two sits an HTTP call with a ten-second timeout, and holding a database
   * connection across it would tie a pool slot to somebody else's server for
   * as long as they cared to be slow.
   *
   * `runInTenantTransaction` rather than `runInNewTenantTransaction`: `retryLog`
   * reaches here from inside a request that already has a tenant open, and
   * demanding a new one there would refuse the nested transaction outright.
   */
  private async record(orgId: string, rows: readonly DeliveryLogRow[]): Promise<void> {
    await runInTenantTransaction(
      this.db,
      (tx) => tx.insert(webhookLogs).values([...rows]).then(() => undefined),
      { orgId },
    );
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
    await this.record(orgId, [row]);
    return { success: true };
  }
}
