import { randomUUID } from "crypto";
import type { DispatchEventInput, NotificationChannel } from "./notification.types";

export function buildNotifOutboxDedupeKey(input: DispatchEventInput): string {
  const targets = [...input.targetUserIds].sort().join(",");
  const discriminator = input.dedupeKey ?? randomUUID();
  return `${input.eventKey}:${input.entityType ?? ""}:${input.entityId ?? ""}:${targets}:${discriminator}`;
}

export function buildNotifIdempotencyKey(
  input: DispatchEventInput,
  userId: string,
  channel: NotificationChannel,
  dedupeWindowSeconds: number,
): string {
  const entity = `${input.entityType ?? ""}:${input.entityId ?? ""}`;
  const windowBucket =
    dedupeWindowSeconds > 0 ? Math.floor(Date.now() / (dedupeWindowSeconds * 1000)).toString() : randomUUID();
  const bucket = input.dedupeKey ?? windowBucket;
  return `org:${input.orgId}:event:${input.eventKey}:user:${userId}:entity:${entity}:channel:${channel}:dedupe:${bucket}`;
}
