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
import { logSideEffectFailure } from "../../common/logger/side-effect";
import {
  decryptSecret,
  isEncryptedSecret,
} from "../../common/security/secret-encryption.util";
import { WEBHOOK_RESPONSE_BODY_LIMIT } from "./dto/webhook.schemas";

const WEBHOOK_TIMEOUT_MS = 10_000;

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

@Injectable()
export class WebhooksDispatchService {
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
    void this.run(orgId, eventName, payload).catch(
      logSideEffectFailure("webhook dispatch", { orgId, eventName }),
    );
  }

  private async run(orgId: string, eventName: string, payload: Record<string, unknown>): Promise<void> {
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

    let statusCode: number | null = null;
    let responseBody: string | null;
    let success = false;

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

    await this.record(orgId, {
      endpointId: endpoint.id,
      orgId,
      event: eventName,
      payload,
      statusCode,
      responseBody: responseBody?.slice(0, WEBHOOK_RESPONSE_BODY_LIMIT) ?? null,
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
