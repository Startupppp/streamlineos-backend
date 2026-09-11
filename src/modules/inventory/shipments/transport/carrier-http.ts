import { checkWebhookUrl, type WebhookUrlCheck } from "../../../../common/security/ssrf-guard";
import { outboundTraceHeaders } from "../../../../common/outbound/call-provider";
import { CARRIER_CALL_TIMEOUT_MS } from "../carrier-adapter";

/**
 * INV-26 — the one place a carrier adapter is allowed to touch the network.
 *
 * It exists so that the things every adapter must get right are written once:
 * the SSRF check, the refusal to follow a redirect, the deadline, and the rule
 * that a non-2xx or an unreadable body is a *value* rather than a throw.
 * `WebhookTransportService` is the same shape for outbound webhooks and this is
 * deliberately its sibling rather than a second copy of `fetch` with different
 * mistakes in it.
 *
 * ## Why the SSRF check runs on every call
 *
 * `inv_carriers.api_base_url` is a tenant value. A tenant that can point a
 * courier integration at the cloud metadata address has an SSRF primitive
 * own infrastructure, and the check runs per call rather than only when the
 * row is written because DNS is not immutable: a hostname that resolved
 * publicly at configuration time can be re-pointed an hour later.
 * `redirect: "manual"` is part of the same guard, not a nicety — a permitted
 * host answering 302 to an internal address defeats the resolution check
 * entirely, so a redirect is a failed call.
 *
 * ## Why it is a seam
 *
 * The guard blocks loopback, which is correct and is exactly what a test
 * against a stub server on loopback needs to get past. Rather than weaken
 * the guard or mock `fetch` — which would stop the test exercising the timeout,
 * the redirect refusal and the JSON reading, i.e. the parts worth testing —
 * `createCarrierHttp` takes the URL check as a parameter. Production passes the
 * real one, and does so by default.
 */

export interface CarrierHttpRequest {
  readonly url: string;
  readonly method: "GET" | "POST";
  /** The tenant's courier key. Sent as a bearer token, never logged. */
  readonly credential: string;
  readonly body?: unknown;
  readonly timeoutMs?: number;
}

export type CarrierHttpResult =
  /** The server answered. `status` may still be 4xx or 5xx — that is the caller's to read. */
  | { readonly ok: true; readonly status: number; readonly body: unknown }
  /** Nothing usable came back: blocked, timed out, redirected, or unreadable. */
  | { readonly ok: false; readonly reason: string };

export interface CarrierHttp {
  request(input: CarrierHttpRequest): Promise<CarrierHttpResult>;
}

/** Injection token, so an adapter can take an override without DI reflection. */
export const CARRIER_HTTP = Symbol("CARRIER_HTTP");

export type CarrierUrlCheck = (url: string) => Promise<WebhookUrlCheck>;

export function createCarrierHttp(
  options: { readonly urlCheck?: CarrierUrlCheck } = {},
): CarrierHttp {
  const urlCheck = options.urlCheck ?? checkWebhookUrl;

  return {
    async request(input: CarrierHttpRequest): Promise<CarrierHttpResult> {
      const guard = await urlCheck(input.url);
      if (!guard.allowed) return { ok: false, reason: `ssrf-guard:${guard.reason}` };

      const timeoutMs = input.timeoutMs ?? CARRIER_CALL_TIMEOUT_MS;
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(input.url, {
          method: input.method,
          headers: {
            // The credential goes in a header, never in the URL: a query string
            // is written to every proxy log between here and the courier.
            Authorization: `Bearer ${input.credential}`,
            Accept: "application/json",
            ...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
            ...outboundTraceHeaders(),
          },
          ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
          signal: controller.signal,
          redirect: "manual",
        });

        if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
          return { ok: false, reason: `redirect-refused:${response.status}` };
        }

        const text = await response.text();
        // An empty body is legitimate on some answers, so it reads as `null`
        // rather than as a parse failure; anything else that will not parse is
        // a courier speaking a format this adapter does not.
        if (text.trim() === "") return { ok: true, status: response.status, body: null };
        try {
          // Declared `unknown` rather than asserted: `JSON.parse` returns `any`,
          // and a declaration narrows the value where an assertion would only
          // silence the reader. Every caller parses it with Zod before use.
          const body: unknown = JSON.parse(text);
          return { ok: true, status: response.status, body };
        } catch {
          return { ok: false, reason: `unreadable-body:${response.status}` };
        }
      } catch (error: unknown) {
        if (controller.signal.aborted) {
          return { ok: false, reason: `timeout after ${timeoutMs}ms` };
        }
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      } finally {
        clearTimeout(deadline);
      }
    },
  };
}

/** What every adapter gets unless something hands it a different one. */
export const defaultCarrierHttp: CarrierHttp = createCarrierHttp();
