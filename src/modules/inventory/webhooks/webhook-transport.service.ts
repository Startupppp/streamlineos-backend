import { Injectable } from "@nestjs/common";
import { checkWebhookUrl } from "../../../common/security/ssrf-guard";
import {
  WEBHOOK_ATTEMPT_HEADER,
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_EVENT_TYPE_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  webhookSignatureHeaderValue,
} from "./webhook-signature";
import { WEBHOOK_DELIVERY_TIMEOUT_MS } from "./webhook-delivery-policy";
import { outboundTraceHeaders } from "../../../common/outbound/call-provider";

export interface WebhookDeliveryTarget {
  readonly id: number;
  readonly url: string;
  readonly secret: string;
}

export interface WebhookDeliveryEvent {
  readonly id: number;
  readonly eventType: string;
  readonly payload: unknown;
  readonly createdAt: Date;
  /** 1-based number of *this* attempt, sent so a receiver can tell a retry from a first delivery. */
  readonly attempt: number;
}

/** An unparseable URL is not https, and must not throw out of the delivery path. */
function isHttps(rawUrl: string): boolean {
  try {
    return new URL(rawUrl).protocol === "https:";
  } catch {
    return false;
  }
}

export type WebhookDeliveryOutcome =
  | { readonly ok: true; readonly httpStatus: number }
  | { readonly ok: false; readonly httpStatus: number | null; readonly error: string };

/**
 * E7 — the one place an inventory webhook is put on the wire.
 *
 * It exists because there were two: `InventoryWebhookEmitter` and
 * `WebhooksService.retryEvent` each built their own body, signed it their own
 * way and ran their own fetch. Two copies of a signing scheme is one copy that
 * gets fixed, so the manual retry button would have kept shipping the replayable
 * `sha256=<body>` signature after the emitter stopped.
 *
 * The SSRF check is `common/security/ssrf-guard`'s and is re-run on *every*
 * attempt rather than only at registration: DNS is not immutable, and a hostname
 * that resolved publicly when the subscription was created can be re-pointed at
 * 169.254.169.254 an hour later. `redirect: "manual"` is part of that guard, not
 * an optimisation — a permitted host answering 302 to an internal address defeats
 * the resolution check entirely, so a redirect is a failed delivery.
 */
@Injectable()
export class WebhookTransportService {
  async deliver(
    target: WebhookDeliveryTarget,
    event: WebhookDeliveryEvent,
    options: { readonly requireHttps: boolean },
  ): Promise<WebhookDeliveryOutcome> {
    const ssrf = await checkWebhookUrl(target.url);
    if (!ssrf.allowed) {
      return { ok: false, httpStatus: null, error: `ssrf-guard:${ssrf.reason}` };
    }

    if (options.requireHttps && !isHttps(target.url)) {
      return { ok: false, httpStatus: null, error: "ssrf-guard:https-required-in-production" };
    }

    const sentAt = new Date();
    const timestampSeconds = Math.floor(sentAt.getTime() / 1000);
    const body = JSON.stringify({
      id: String(event.id),
      type: event.eventType,
      data: event.payload,
      attempt: event.attempt,
      occurredAt: event.createdAt.toISOString(),
      sentAt: sentAt.toISOString(),
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WEBHOOK_DELIVERY_TIMEOUT_MS);
    try {
      const res = await fetch(target.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [WEBHOOK_SIGNATURE_HEADER]: webhookSignatureHeaderValue(
            target.secret,
            timestampSeconds,
            body,
          ),
          [WEBHOOK_TIMESTAMP_HEADER]: String(timestampSeconds),
          [WEBHOOK_EVENT_ID_HEADER]: String(event.id),
          [WEBHOOK_EVENT_TYPE_HEADER]: event.eventType,
          [WEBHOOK_ATTEMPT_HEADER]: String(event.attempt),
          ...outboundTraceHeaders(),
        },
        body,
        signal: controller.signal,
        redirect: "manual",
      });

      if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
        return { ok: false, httpStatus: res.status, error: `redirect-refused:${res.status}` };
      }
      if (!res.ok) {
        return { ok: false, httpStatus: res.status, error: `http:${res.status}` };
      }
      return { ok: true, httpStatus: res.status };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        httpStatus: null,
        error: controller.signal.aborted ? `timeout after ${WEBHOOK_DELIVERY_TIMEOUT_MS}ms` : message,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
