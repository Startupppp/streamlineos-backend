import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import {
  resolveSafeWebhookTarget,
  type SafeWebhookTarget,
} from "../security/ssrf-guard";

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

export async function postSafeWebhook(
  rawUrl: string,
  body: string,
  headers: Readonly<Record<string, string>>,
  timeoutMs: number,
  responseBodyLimit: number,
): Promise<SafeWebhookResponse> {
  const target = await resolveSafeWebhookTarget(rawUrl);
  if ("reason" in target) throw new UnsafeWebhookTargetError(target.reason);

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
