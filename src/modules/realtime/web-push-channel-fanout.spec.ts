/**
 * The per-message web-push fan-out selected every channel member and fired one
 * `sendToUser` per member with NO concurrency bound:
 *
 *     await Promise.allSettled(members.map((m) => this.sendToUser(...)))
 *
 * One message in a 5,000-member org-wide channel is therefore 5,000 simultaneous
 * `sendToUser` calls, each of which issues its own `push_subscriptions` SELECT,
 * an `ExternalEffectLedger.execute` write and an HTTPS push per subscription —
 * 10,000+ concurrent database round trips against a pool whose `max` is 10-20.
 * The pool is exhausted and the rest of the request path starves behind it.
 *
 * Independently, `muted_until` and `notification_preference` — both columns of
 * `chat_channel_members`, the table this query already joins — were read
 * nowhere on this path, so a user who muted a channel until tomorrow, or set it
 * to mentions-only, still got a device push for every message. The sibling Ably
 * path (`chat-notifications.service.ts:62-84`) filters on both and uses
 * `boundedMap(recipients, PUBLISH_CONCURRENCY, …)`, so the correct behaviour
 * already existed one file away.
 *
 * NOT fixed here, and deliberately: the `DEFAULT` sentinel resolves against
 * `chat_org_settings.defaultNotificationPreference`, which lives behind
 * `ChatOrgSettingsService`. `ChatModule` imports `RealtimeModule`, so realtime
 * cannot import chat back without a module cycle; resolving `DEFAULT` correctly
 * means the chat module resolving the recipient set and handing it over. A
 * member left on `DEFAULT` is unchanged by this commit — no regression, and the
 * explicit opt-outs now hold.
 */
import type { SQL } from "drizzle-orm";
import * as webpush from "web-push";
import { PgDialect } from "drizzle-orm/pg-core";
import { WebPushService, PUSH_FANOUT_CONCURRENCY } from "./web-push.service";
import type { Db } from "../../db/drizzle.module";
import type { AppConfig } from "../../config/env.validation";
import type { ExternalEffectLedger } from "../../common/outbox/external-effect-ledger";

const ORG = "org-fanout";
const SENDER = "sender-user";
const FUTURE = new Date(Date.now() + 86_400_000);
const PAST = new Date(Date.now() - 86_400_000);

// Real keys: the constructor hands them to web-push, which rejects placeholders.
const vapid = webpush.generateVAPIDKeys();
const config = {
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
  APP_URL: "https://app.example.com",
  EMAIL_FROM_ADDRESS: "noreply@example.com",
} as unknown as AppConfig;

interface MemberRow {
  userId: string;
  mutedUntil: Date | null;
  notificationPreference: string;
}

function makeService(members: MemberRow[]): {
  service: WebPushService;
  where: SQL[];
} {
  const where: SQL[] = [];
  const db = {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        innerJoin: jest.fn(() => ({
          where: jest.fn((clause: SQL) => {
            where.push(clause);
            return Promise.resolve(members);
          }),
        })),
      })),
    })),
  };
  const service = new WebPushService(
    db as unknown as Db,
    config,
    { execute: jest.fn() } as unknown as ExternalEffectLedger,
  );
  return { service, where };
}

function member(userId: string, overrides: Partial<MemberRow> = {}): MemberRow {
  return { userId, mutedUntil: null, notificationPreference: "DEFAULT", ...overrides };
}

describe("WebPushService.sendToChannelMembers — recipient filter", () => {
  it("does not push to a member whose mute has not expired", async () => {
    const { service } = makeService([
      member("muted", { mutedUntil: FUTURE }),
      member("listening"),
    ]);
    const sendToUser = jest.spyOn(service, "sendToUser").mockResolvedValue(undefined);

    await service.sendToChannelMembers(ORG, 42, SENDER, { category: "CHAT" });

    expect(sendToUser.mock.calls.map((call) => call[1])).toEqual(["listening"]);
  });

  it("pushes again once the mute has expired", async () => {
    const { service } = makeService([member("was-muted", { mutedUntil: PAST })]);
    const sendToUser = jest.spyOn(service, "sendToUser").mockResolvedValue(undefined);

    await service.sendToChannelMembers(ORG, 42, SENDER, { category: "CHAT" });

    expect(sendToUser.mock.calls.map((call) => call[1])).toEqual(["was-muted"]);
  });

  it.each(["NOTHING", "MENTIONS"])(
    "does not push to a member who explicitly chose %s for this channel",
    async (preference) => {
      const { service } = makeService([
        member("opted-out", { notificationPreference: preference }),
        member("listening", { notificationPreference: "ALL" }),
      ]);
      const sendToUser = jest.spyOn(service, "sendToUser").mockResolvedValue(undefined);

      await service.sendToChannelMembers(ORG, 42, SENDER, { category: "CHAT" });

      expect(sendToUser.mock.calls.map((call) => call[1])).toEqual(["listening"]);
    },
  );

  it("still pushes to a member left on DEFAULT — the org default is resolved in chat, not here", async () => {
    const { service } = makeService([member("default-member")]);
    const sendToUser = jest.spyOn(service, "sendToUser").mockResolvedValue(undefined);

    await service.sendToChannelMembers(ORG, 42, SENDER, { category: "CHAT" });

    expect(sendToUser.mock.calls.map((call) => call[1])).toEqual(["default-member"]);
  });

  it("keeps the member lookup scoped to the organization", async () => {
    const { service, where } = makeService([]);
    jest.spyOn(service, "sendToUser").mockResolvedValue(undefined);

    await service.sendToChannelMembers(ORG, 42, SENDER, { category: "CHAT" });

    const rendered = new PgDialect().sqlToQuery(where[0] as SQL);
    expect(rendered.params).toContain(ORG);
  });
});

describe("WebPushService.sendToChannelMembers — bounded fan-out", () => {
  it(`never holds more than PUSH_FANOUT_CONCURRENCY (${String(PUSH_FANOUT_CONCURRENCY)}) sends open at once`, async () => {
    const members = Array.from({ length: PUSH_FANOUT_CONCURRENCY * 6 }, (_, i) =>
      member(`user-${String(i)}`),
    );
    const { service } = makeService(members);

    let inFlight = 0;
    let peak = 0;
    jest.spyOn(service, "sendToUser").mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
    });

    await service.sendToChannelMembers(ORG, 42, SENDER, { category: "CHAT" });

    expect(peak).toBeLessThanOrEqual(PUSH_FANOUT_CONCURRENCY);
    // Bounded, not truncated: dropping recipients to protect the pool would turn
    // a resource problem into a correctness one.
    expect(peak).toBeGreaterThan(1);
  });

  it("delivers to every member even though only a window is in flight at a time", async () => {
    const members = Array.from({ length: PUSH_FANOUT_CONCURRENCY * 3 + 1 }, (_, i) =>
      member(`user-${String(i)}`),
    );
    const { service } = makeService(members);
    const sendToUser = jest.spyOn(service, "sendToUser").mockResolvedValue(undefined);

    await service.sendToChannelMembers(ORG, 42, SENDER, { category: "CHAT" });

    expect(sendToUser).toHaveBeenCalledTimes(members.length);
  });

  it("aggregates failures rather than letting one bad subscription abort the wave", async () => {
    const { service } = makeService([member("a"), member("b"), member("c")]);
    jest
      .spyOn(service, "sendToUser")
      .mockImplementation(async (_org, userId) => {
        if (userId === "b") throw new Error("gone");
      });

    await expect(
      service.sendToChannelMembers(ORG, 42, SENDER, { category: "CHAT" }),
    ).rejects.toThrow(AggregateError);
  });
});
