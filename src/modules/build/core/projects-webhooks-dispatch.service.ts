import { Inject, Injectable } from "@nestjs/common";
import { createHmac, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { projectWebhooks, webhookDeliveries } from "../../../db/schema/build/tasks";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { logger } from "../../../common/logger/logger.service";
import { logSideEffectFailure } from "../../../common/logger/side-effect";
import { checkWebhookUrl } from "./webhook-url-guard";
import {
  callProvider,
  type ProviderCallResult,
  type ProviderDescriptor,
} from "../../../common/outbound/call-provider";
import { ProviderCircuitBreaker } from "../../../common/outbound/provider-circuit-breaker";

const WEBHOOK_TIMEOUT_MS = 10_000;
const RESPONSE_BODY_LIMIT = 2000;
const WEBHOOK_MAX_ATTEMPTS = 5;
const WEBHOOK_BASE_DELAY_MS = 1_000;
const WEBHOOK_MAX_DELAY_MS = 30_000;

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

interface WebhookResponse {
  statusCode: number;
  responseBody: string;
}

interface DeliveryOutcome {
  responseCode: number | null;
  responseBody: string | null;
  success: boolean;
  lastError: string | null;
  attempts: number;
  nextAttemptAt: Date | null;
}

export class ProjectWebhookResponseError extends Error {
  constructor(
    readonly statusCode: number,
    readonly responseBody: string,
  ) {
    super(`HTTP ${statusCode}`);
    this.name = "ProjectWebhookResponseError";
  }
}

export function classifyProjectWebhookError(error: unknown): "terminal" | "retryable" {
  if (!(error instanceof ProjectWebhookResponseError)) return "retryable";
  if ([408, 425, 429].includes(error.statusCode)) return "retryable";
  return error.statusCode >= 400 && error.statusCode < 500 ? "terminal" : "retryable";
}

function outcomeFromProviderResult(
  result: ProviderCallResult<WebhookResponse>,
): DeliveryOutcome {
  if (result.ok)
    return {
      responseCode: result.value.statusCode,
      responseBody: result.value.responseBody,
      success: true,
      lastError: null,
      attempts: result.attempts,
      nextAttemptAt: null,
    };

  if (result.kind === "circuit-open")
    return {
      responseCode: null,
      responseBody: null,
      success: false,
      lastError: `Circuit open; retry after ${result.retryAfterMs}ms`,
      attempts: result.attempts,
      nextAttemptAt: null,
    };

  const responseError =
    result.error instanceof ProjectWebhookResponseError ? result.error : null;
  return {
    responseCode: responseError?.statusCode ?? null,
    responseBody: responseError?.responseBody ?? null,
    success: false,
    lastError:
      result.kind === "dead-lettered"
        ? `Dead after ${result.attempts} attempts: ${result.error.message}`
        : result.error.message,
    attempts: result.attempts,
    nextAttemptAt: null,
  };
}

@Injectable()
export class ProjectsWebhooksDispatchService {
  private readonly breaker = new ProviderCircuitBreaker();

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  dispatch(orgId: string, projectId: number, eventName: string, payload: WebhookPayload): void {
    void this.run(orgId, projectId, eventName, payload).catch(logSideEffectFailure("webhook dispatch", { orgId, projectId, event: eventName }));
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
        this.deliver(
          { id: row.id, url: row.url, secret: row.secret ?? "", orgId: row.orgId },
          eventName,
          payload,
        ),
      ),
    );
  }

  private async deliver(
    endpoint: ActiveEndpoint,
    eventName: string,
    payload: WebhookPayload,
  ): Promise<DeliveryOutcome> {
    const body = JSON.stringify({ event: eventName, data: payload, timestamp: new Date().toISOString() });
    const signature = createHmac("sha256", endpoint.secret || "").update(body).digest("hex");

    const urlCheck = await checkWebhookUrl(endpoint.url);
    if (!urlCheck.allowed) {
      const blocked: DeliveryOutcome = {
        responseCode: null,
        responseBody: null,
        success: false,
        lastError: `Blocked webhook target (${urlCheck.reason})`,
        attempts: 1,
        nextAttemptAt: null,
      };
      await this.recordDelivery(endpoint, eventName, payload, blocked);
      return blocked;
    }

    const descriptor: ProviderDescriptor = {
      provider: `build-webhook:${endpoint.id}`,
      timeoutMs: WEBHOOK_TIMEOUT_MS,
      maxAttempts: WEBHOOK_MAX_ATTEMPTS,
      baseDelayMs: WEBHOOK_BASE_DELAY_MS,
      maxDelayMs: WEBHOOK_MAX_DELAY_MS,
      classify: classifyProjectWebhookError,
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
        const responseBody = await response.text().catch(() => "");
        if (!response.ok)
          throw new ProjectWebhookResponseError(response.status, responseBody);
        return { statusCode: response.status, responseBody };
      },
      this.breaker,
    );
    const outcome = outcomeFromProviderResult(result);
    await this.recordDelivery(endpoint, eventName, payload, outcome);
    return outcome;
  }

  private async recordDelivery(
    endpoint: ActiveEndpoint,
    eventName: string,
    payload: WebhookPayload,
    outcome: DeliveryOutcome,
  ): Promise<void> {
    try {
      await this.db.insert(webhookDeliveries).values({
        orgId: endpoint.orgId,
        webhookId: endpoint.id,
        event: eventName,
        payload,
        status: outcome.success ? "success" : "failed",
        responseCode: outcome.responseCode,
        responseBody: outcome.responseBody?.slice(0, RESPONSE_BODY_LIMIT) ?? null,
        attempts: outcome.attempts,
        lastError: outcome.lastError,
        nextAttemptAt: outcome.nextAttemptAt,
      });
    } catch (dbError) {
      logger.error("Failed to record webhook delivery", { dbError });
    }
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

    const outcome = await this.deliver(
      { id: row.id, url: row.url, secret: row.secret ?? "", orgId: row.orgId },
      "webhook.test",
      testPayload,
    );
    return { success: outcome.success, responseCode: outcome.responseCode };
  }
}

export function generateWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}
