/**
 * The declared `dedupeWindowSeconds` applied to almost nothing.
 *
 * `buildNotifOutboxDedupeKey` minted a fresh `randomUUID()` for every emit that did
 * not pass an explicit key. That value was stored on the outbox row and handed back
 * by the relay as `input.dedupeKey`, and `buildNotifIdempotencyKey` reads
 * `input.dedupeKey ?? windowBucket` — so the random value WON over the time bucket
 * it was supposed to fall back to. Two identical emits five seconds apart therefore
 * produced two distinct idempotency keys, two `notification_deliveries` rows and two
 * notifications, for an event declaring a 60-second window.
 *
 * 68 of 86 catalog events take the default 60 s, and only 27 of 111 emit sites pass
 * an explicit key. The one existing spec here ("idempotent materialization under
 * relay replay") uses a FIXED key and `dedupeWindowSeconds: 0`, so it exercised
 * neither half of the window path and passed against the broken value.
 */
import {
  buildNotifIdempotencyKey,
  buildNotifOutboxDedupeKey,
} from "./notification-dispatch-keys";
import type { DispatchEventInput } from "./notification.types";

const INPUT: DispatchEventInput = {
  eventKey: "hr.leave.approved",
  orgId: "org-1",
  targetUserIds: ["user-2", "user-1"],
  entityType: "leave_request",
  entityId: "77",
};

const T0 = Date.UTC(2026, 0, 5, 12, 0, 0);

describe("notification dedupe window", () => {
  it("two emits inside the window build the SAME delivery key — the defect", () => {
    // Head form: the relay handed the outbox key back as `dedupeKey`, that key is a
    // random UUID for an emission without an explicit one, and it won over the
    // bucket. So this pair used to differ and two notifications were produced.
    const firstOutboxKey = buildNotifOutboxDedupeKey(INPUT);
    const secondOutboxKey = buildNotifOutboxDedupeKey(INPUT);
    expect(secondOutboxKey).not.toBe(firstOutboxKey);

    const first = buildNotifIdempotencyKey(
      { ...INPUT, replayKey: firstOutboxKey }, "user-1", "IN_APP", 60, T0);
    const second = buildNotifIdempotencyKey(
      { ...INPUT, replayKey: secondOutboxKey }, "user-1", "IN_APP", 60, T0 + 5_000);

    expect(second).toBe(first);
  });

  it("two emits in different windows build different delivery keys", () => {
    const first = buildNotifIdempotencyKey(INPUT, "user-1", "IN_APP", 60, T0);
    const later = buildNotifIdempotencyKey(INPUT, "user-1", "IN_APP", 60, T0 + 65_000);

    expect(later).not.toBe(first);
  });

  it("the outbox key stays unique per emission — it is the intent's identity", () => {
    // A stable outbox key would collapse the second comment on a ticket into the
    // first PERMANENTLY, via onConflictDoNothing on (org_id, dedupe_key): outbox rows
    // carry no timestamp and are never deleted. The window belongs at the delivery
    // key, which is bucketed and therefore self-expiring.
    expect(buildNotifOutboxDedupeKey(INPUT)).not.toBe(buildNotifOutboxDedupeKey(INPUT));
  });

  it("a zero window falls back to the replay key, so a relay retry cannot double-notify", () => {
    // The relay's docblock names these: mentions, DMs and invites set
    // dedupeWindowSeconds: 0 and have no bucket to fall back to, so dropping the
    // replay key there makes a retry deliver twice.
    const replayKey = "outbox-row-77";
    const first = buildNotifIdempotencyKey({ ...INPUT, replayKey }, "user-1", "IN_APP", 0, T0);
    const retry = buildNotifIdempotencyKey({ ...INPUT, replayKey }, "user-1", "IN_APP", 0, T0 + 90_000);

    expect(retry).toBe(first);
    // And two GENUINE zero-window emissions still stay distinct.
    const other = buildNotifIdempotencyKey({ ...INPUT, replayKey: "outbox-row-78" }, "user-1", "IN_APP", 0, T0);
    expect(other).not.toBe(first);
  });

  it("an explicit caller dedupeKey wins over both the bucket and the replay key", () => {
    const explicit: DispatchEventInput = { ...INPUT, dedupeKey: "producer-event-9", replayKey: "outbox-row-77" };

    expect(buildNotifIdempotencyKey(explicit, "user-1", "IN_APP", 60, T0)).toBe(
      buildNotifIdempotencyKey(explicit, "user-1", "IN_APP", 60, T0 + 10 * 60_000),
    );
    expect(buildNotifOutboxDedupeKey(explicit)).toBe(buildNotifOutboxDedupeKey(explicit));
  });

  it("different recipients, entities and channels stay distinct inside one window", () => {
    const keys = new Set([
      buildNotifIdempotencyKey(INPUT, "user-1", "IN_APP", 60, T0),
      buildNotifIdempotencyKey(INPUT, "user-2", "IN_APP", 60, T0),
      buildNotifIdempotencyKey(INPUT, "user-1", "EMAIL", 60, T0),
      buildNotifIdempotencyKey({ ...INPUT, entityId: "78" }, "user-1", "IN_APP", 60, T0),
      buildNotifIdempotencyKey({ ...INPUT, orgId: "org-2" }, "user-1", "IN_APP", 60, T0),
    ]);

    expect(keys.size).toBe(5);
  });
});
