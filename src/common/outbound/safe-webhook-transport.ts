import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import {
  resolveSafeWebhookTarget,
  type SafeWebhookTarget,
} from "../security/ssrf-guard";
import { outboundTraceHeaders } from "./call-provider";
import { withSpan } from "../observability/tracing";

export interface SafeWebhookResponse {
  statusCode: number;
  responseBody: string;
}

export class UnsafeWebhookTargetError extends Error {
  constructor(readonly reason: string) {
    super(`Blocked webhook target (${reason})`);
    this.name = "UnsafeWebhookTargetError";
  }
}

export function pinnedLookup(target: SafeWebhookTarget): LookupFunction {
  let cursor = 0;
  return (_hostname, options, callback) => {
    const address = target.addresses[cursor % target.addresses.length];
    cursor += 1;
    if (!address) {
      callback(new Error("Safe webhook target has no pinned address"), "", 4);
      return;
    }
    if (typeof options === "object" && options.all) {
      callback(null, [...target.addresses]);
      return;
    }
    callback(null, address.address, address.family);
  };
}

/**
 * A caller's own headers always win.
 *
 * A webhook is usually signed, and the signature covers a header set the caller
 * decided on. Adding to it is safe; replacing anything in it would invalidate
 * the signature at the receiver, so trace headers are only ever filled into a
 * name the caller left empty.
 */
function withTraceHeaders(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  const present = new Set(Object.keys(headers).map((name) => name.toLowerCase()));
  const merged: Record<string, string> = { ...headers };
  for (const [name, value] of Object.entries(outboundTraceHeaders()))
    if (!present.has(name.toLowerCase())) merged[name] = value;
  return merged;
}

export async function postSafeWebhook(
  rawUrl: string,
  body: string,
  headers: Readonly<Record<string, string>>,
  timeoutMs: number,
  responseBodyLimit: number,
): Promise<SafeWebhookResponse> {
  const target = await resolveSafeWebhookTarget(rawUrl);
  if ("reason" in target) throw new UnsafeWebhookTargetError(target.reason);

  /**
   * Wrapped in a span, and the headers are read inside it.
   *
   * This is the one outbound path that does not go through `outboundRequest` —
   * it pins DNS to the addresses the SSRF guard resolved, which `fetch` cannot
   * express. That made it the one provider boundary a tenant's own trace stopped
   * at: the receiver had no `traceparent` to continue, and a delivery failure
   * could not be joined to the change that triggered it. Reading the headers
   * inside `withSpan` names this span rather than the caller's, so the
   * receiver's half of the trace is a child of the delivery, not its sibling.
   *
   * The span name is fixed rather than built from the target host: a customer's
   * webhook hostname is that customer's data, and a span name is not a place a
   * redactor can reach.
   */
  return withSpan(
    "provider.webhook",
    () => send(target, body, withTraceHeaders(headers), timeoutMs, responseBodyLimit),
    { attributes: { "provider.name": "webhook" } },
  );
}

function send(
  target: SafeWebhookTarget,
  body: string,
  headers: Readonly<Record<string, string>>,
  timeoutMs: number,
  responseBodyLimit: number,
): Promise<SafeWebhookResponse> {
  const request = target.url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise<SafeWebhookResponse>((resolve, reject) => {
    const req = request(target.url, {
      method: "POST",
      headers: { ...headers, "Content-Length": Buffer.byteLength(body).toString() },
      lookup: pinnedLookup(target),
      timeout: timeoutMs,
    }, (res) => {
      let responseBody = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        if (responseBody.length < responseBodyLimit)
          responseBody += chunk.slice(0, responseBodyLimit - responseBody.length);
      });
      res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, responseBody }));
    });
    req.on("timeout", () => req.destroy(new Error(`Webhook timed out after ${timeoutMs}ms`)));
    req.on("error", reject);
    req.end(body);
  });
}
