import { randomUUID } from "crypto";
import type { DispatchEventInput, NotificationChannel } from "./notification.types";

/**
 * The outbox row's identity: one row per genuine emission, stable across replays of
 * that emission because it is minted once and stored.
 *
 * The random default is correct here and is deliberately kept. The key carries no
 * timestamp and outbox rows are never deleted, so a stable default would collapse
 * the second comment on a ticket into the first permanently and silently, via the
 * `onConflictDoNothing` on (org_id, dedupe_key).
 */
export function buildNotifOutboxDedupeKey(input: DispatchEventInput): string {
  const targets = [...input.targetUserIds].sort().join(",");
  const discriminator = input.dedupeKey ?? randomUUID();
  return `${input.eventKey}:${input.entityType ?? ""}:${input.entityId ?? ""}:${targets}:${discriminator}`;
}

/**
 * The delivery's identity, which is what `notification_deliveries.idempotency_key`
 * refuses a second time.
 *
 * WHAT WAS WRONG. This read `input.dedupeKey ?? windowBucket`, and the two replay
 * paths — the after-commit drain and `NotificationOutboxRelayService` — passed the
 * outbox row's key back as `dedupeKey`. That key is a random UUID for any emission
 * without an explicit caller key, which is 84 of the 111 emit sites, so the random
 * value WON over the time bucket and the declared `dedupeWindowSeconds` applied to
 * almost nothing: two identical emits five seconds apart built two distinct
 * idempotency keys, inserted two delivery rows and produced two notifications. 68 of
 * the 86 catalog events take the default 60-second window. The one existing spec in
 * this area pins a FIXED key with `dedupeWindowSeconds: 0`, so it exercised neither
 * half of the window path and passed against the broken value.
 *
 * The three discriminators now have an explicit precedence, and each is the right
 * answer for its own case:
 *
 *   1. An EXPLICIT caller `dedupeKey` always wins. A bus consumer passing a producer
 *      event id means exactly-once against that id, whatever the window says.
 *   2. Otherwise a window > 0 uses the time bucket. This is the declared behaviour,
 *      and it is what was unreachable before.
 *   3. Otherwise (window = 0) the outbox row's `replayKey`. There is no bucket to
 *      fall back to, and the relay's docblock names the events that set it —
 *      mentions, DMs, invites — as the ones that must double-deliver rather than be
 *      collapsed. Dropping this argument makes a relay replay of one of them
 *      double-notify.
 *
 * The residual, stated rather than hidden: a window > 0 event replayed by the relay
 * MORE than one window later (its 60 s lease expired because the process died
 * mid-dispatch) lands in a new bucket and can notify twice. That is a duplicate on a
 * crash-recovery path, traded against the window failing to apply on every ordinary
 * emission — which is what it replaces.
 */
export function buildNotifIdempotencyKey(
  input: DispatchEventInput,
  userId: string,
  channel: NotificationChannel,
  dedupeWindowSeconds: number,
  now: number = Date.now(),
): string {
  const entity = `${input.entityType ?? ""}:${input.entityId ?? ""}`;
  const bucket =
    input.dedupeKey ??
    (dedupeWindowSeconds > 0
      ? Math.floor(now / (dedupeWindowSeconds * 1000)).toString()
      : (input.replayKey ?? randomUUID()));
  return `org:${input.orgId}:event:${input.eventKey}:user:${userId}:entity:${entity}:channel:${channel}:dedupe:${bucket}`;
}
