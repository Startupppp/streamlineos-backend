import { createHmac } from "node:crypto";

export function buildSignedRequest(
  signingSecret: string,
  eventName: string,
  payload: unknown,
  deliveryId: number,
): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify({
    event: eventName,
    data: payload ?? {},
    timestamp: new Date().toISOString(),
  });
  const signature = createHmac("sha256", signingSecret).update(body).digest("hex");
  return {
    body,
    headers: {
      "Content-Type": "application/json",
      "X-StreamlineOS-Signature": `sha256=${signature}`,
      "X-Webhook-Event": eventName,
      "X-StreamlineOS-Delivery-Id": String(deliveryId),
    },
  };
}
