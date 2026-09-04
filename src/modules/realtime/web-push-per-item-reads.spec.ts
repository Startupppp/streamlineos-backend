/**
 * PRD-C145 — "without table scans, N+1 or per-item cache/database calls".
 *
 * Two defects on the chat push fan-out, both on the request path of every
 * message:
 *
 * 1. `sendToChannelMembers` bounded its CONCURRENCY but not its READ COUNT.
 *    Every recipient still went through `sendToUser`, and `sendToUser` opened
 *    its own `push_subscriptions` SELECT — one database round trip per member,
 *    which is the per-item database call this criterion names. The recipients
 *    for a page are now read in one query and handed down, so reads grow with
 *    pages (`PUSH_SUBSCRIPTION_BATCH`) and not with members.
 *
 * 2. Both entry points THREW `new Error("Web Push is not configured")` when
 *    they were called with an idempotency key and no VAPID keys were set.
 *    `ChatMessageFanoutService.dispatchDeferred` runs the fan-out inside
 *    `ExternalEffectLedger.execute`, which records FAILED and rethrows, so on a
 *    deployment without VAPID keys every chat message dead-lettered its push
 *    effect — permanently, for a condition no retry can change. Absent
 *    configuration is a skip.
 */
import type { SQL } from "drizzle-orm";
import * as webpush from "web-push";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  WebPushService,
  PUSH_SUBSCRIPTION_BATCH,
  PUSH_FANOUT_CONCURRENCY,
} from "./web-push.service";
import type { Db } from "../../db/drizzle.module";
import type { AppConfig } from "../../config/env.validation";
import type { ExternalEffectLedger } from "../../common/outbox/external-effect-ledger";

const ORG = "org-c145";
const SENDER = "sender-user";
const dialect = new PgDialect();

const vapid = webpush.generateVAPIDKeys();
const configured = {
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
  APP_URL: "https://app.example.com",
  EMAIL_FROM_ADDRESS: "noreply@example.com",
} as unknown as AppConfig;
const unconfigured = {
  VAPID_PUBLIC_KEY: "",
  VAPID_PRIVATE_KEY: "",
  APP_URL: "https://app.example.com",
  EMAIL_FROM_ADDRESS: "noreply@example.com",
} as unknown as AppConfig;

interface MemberRow {
  userId: string;
  mutedUntil: Date | null;
  notificationPreference: string;
}

interface Builder {
  from: () => Builder;
  innerJoin: () => Builder;
  where: (clause: SQL) => Promise<unknown[]>;
}

function harness(members: MemberRow[], config: AppConfig = configured) {
  const memberWhere: SQL[] = [];
  const subscriptionWhere: SQL[] = [];
  const db = {
    select: jest.fn(() => {
      let joined = false;
      const builder: Builder = {
        from: () => builder,
        innerJoin: () => {
          joined = true;
          return builder;
        },
        where: (clause: SQL) => {
          if (joined) {
            memberWhere.push(clause);
            return Promise.resolve(members);
          }
          subscriptionWhere.push(clause);
          return Promise.resolve([]);
        },
      };
      return builder;
    }),
    delete: jest.fn(() => ({ where: jest.fn(() => Promise.resolve()) })),
  };
  const effects = { execute: jest.fn() } as unknown as ExternalEffectLedger;
  const service = new WebPushService(db as unknown as Db, config, effects);
  return { service, memberWhere, subscriptionWhere };
}

function members(count: number): MemberRow[] {
  return Array.from({ length: count }, (_, i) => ({
    userId: `user-${String(i)}`,
    mutedUntil: null,
    notificationPreference: "ALL",
  }));
}

describe("PRD-C145 — the push fan-out reads subscriptions per page, not per recipient", () => {
  it("issues ONE subscription read for a page of recipients, not one per recipient", async () => {
    const count = PUSH_SUBSCRIPTION_BATCH - 1;
    const { service, subscriptionWhere } = harness(members(count));

    await service.sendToChannelMembers(ORG, 42, SENDER, { category: "CHAT" });

    expect(count).toBeGreaterThan(PUSH_FANOUT_CONCURRENCY);
    expect(subscriptionWhere).toHaveLength(1);
  });

  it("grows its read count with pages, not with members", async () => {
    const count = PUSH_SUBSCRIPTION_BATCH * 3 + 1;
    const { service, subscriptionWhere } = harness(members(count));

    await service.sendToChannelMembers(ORG, 42, SENDER, { category: "CHAT" });

    expect(subscriptionWhere).toHaveLength(4);
    expect(subscriptionWhere.length).toBeLessThan(count);
  });

  it("binds the batched subscription read to the caller's organization", async () => {
    const { service, subscriptionWhere } = harness(members(3));

    await service.sendToChannelMembers(ORG, 42, SENDER, { category: "CHAT" });

    const rendered = dialect.sqlToQuery(subscriptionWhere[0] as SQL);
    expect(rendered.sql).toContain("org_id");
    expect(rendered.params).toContain(ORG);
    expect(rendered.params).toContain("user-0");
    expect(rendered.params).toContain("user-2");
  });

  it("still reaches every recipient — batching the read never drops a member", async () => {
    const count = PUSH_SUBSCRIPTION_BATCH * 2 + 5;
    const { service } = harness(members(count));
    const sendToUser = jest.spyOn(service, "sendToUser").mockResolvedValue(undefined);

    await service.sendToChannelMembers(ORG, 42, SENDER, { category: "CHAT" });

    expect(sendToUser).toHaveBeenCalledTimes(count);
  });
});

describe("PRD-C145 — an unconfigured deployment skips the push instead of dead-lettering it", () => {
  it("does not throw when sendToChannelMembers carries an idempotency key and VAPID keys are absent", async () => {
    const { service } = harness(members(2), unconfigured);

    await expect(
      service.sendToChannelMembers(ORG, 42, SENDER, { category: "CHAT" }, "idem-key"),
    ).resolves.toBeUndefined();
  });

  it("does not throw when sendToUser carries an external effect and VAPID keys are absent", async () => {
    const { service } = harness([], unconfigured);

    await expect(
      service.sendToUser(ORG, "user-0", { url: "/notifications" }, {
        orgId: ORG,
        producerEventId: "producer-1",
        effectKey: "effect-1",
      }),
    ).resolves.toBeUndefined();
  });

  it("reads nothing at all when it is not configured", async () => {
    const { service, memberWhere, subscriptionWhere } = harness(members(2), unconfigured);

    await service.sendToChannelMembers(ORG, 42, SENDER, { category: "CHAT" }, "idem-key");

    expect(memberWhere).toHaveLength(0);
    expect(subscriptionWhere).toHaveLength(0);
  });
});
