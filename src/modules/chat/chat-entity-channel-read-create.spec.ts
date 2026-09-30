import "reflect-metadata";
import { Test, type TestingModule } from "@nestjs/testing";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { ChatChannelsService } from "./chat-channels.service";
import { ChatChannelListService } from "./chat-channel-list.service";
import { ChatChannelsController } from "./chat-channels.controller";
import { DRIZZLE } from "../../db/drizzle.constants";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import { EntityReferenceService } from "../entity-reference/entity-reference.service";
import { REQUIRE_PERMISSION } from "../access/require-permission.decorator";
import type { EntityActor } from "../entity-reference/entity-reference.types";

const actor: EntityActor = { orgId: "org1", userId: "user1", membershipId: 10, isOrgOwner: false };

const RESOLVED = {
  status: "resolved" as const,
  card: {
    type: "project",
    id: "42",
    title: "Apollo",
    subtitle: null,
    status: "ACTIVE",
    href: "/build/42",
  },
};

const CHANNEL_ROW = {
  id: 7,
  orgId: "org1",
  name: "Apollo",
  type: "GROUP",
  description: null,
  avatarUrl: null,
  isArchived: false,
  entityType: "project",
  entityId: "42",
  isPinned: false,
  isPrivate: true,
  messageCount: 0,
  lastMessageAt: new Date("2026-09-12T00:00:00.000Z"),
  createdAt: new Date("2026-09-12T00:00:00.000Z"),
  updatedAt: new Date("2026-09-12T00:00:00.000Z"),
  members: [
    {
      channelId: 7,
      id: 1,
      role: "ADMIN",
      membership: {
        userId: "user1",
        user: { id: "user1", name: "User One", image: null, email: "user1@example.com" },
      },
    },
  ],
};

const ORPHANED_CHANNEL_ROW = { ...CHANNEL_ROW, members: [] };

class QuotaExceeded extends Error {}

interface Harness {
  service: ChatChannelsService;
  findFirst: jest.Mock;
  insert: jest.Mock;
  txInsert: jest.Mock;
  returning: jest.Mock;
  resolve: jest.Mock;
  transaction: jest.Mock;
  assertWithinLimit: jest.Mock;
  order: string[];
  txExecute: jest.Mock;
  transactionArg: unknown;
}

async function buildHarness(): Promise<Harness> {
  const findFirst = jest.fn().mockResolvedValue(null);
  const returning = jest.fn().mockResolvedValue([{ id: 7 }]);
  const resolve = jest.fn().mockResolvedValue([RESOLVED]);
  const order: string[] = [];
  const assertWithinLimit = jest.fn(() => {
    order.push("assertWithinLimit");
    return Promise.resolve(undefined);
  });

  const txInsert = jest.fn(() => {
    order.push("insert");
    return {
      values: jest.fn(() => ({
        onConflictDoNothing: jest.fn(() => ({ returning })),
        returning,
      })),
    };
  });

  const txExecute = jest.fn(() => {
    order.push("lockQuota");
    return Promise.resolve([]);
  });

  const harness: { transactionArg: unknown } = { transactionArg: undefined };
  const transaction = jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
    const tx = { insert: txInsert, execute: txExecute };
    harness.transactionArg = tx;
    return cb(tx);
  });

  const insert = jest.fn(() => ({
    values: jest.fn(() => ({
      onConflictDoNothing: jest.fn(() => ({ returning })),
      returning,
    })),
  }));

  const mockDb = {
    query: { chatChannels: { findFirst } },
    insert,
    transaction,
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockResolvedValue([]),
  };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      ChatChannelsService,
      { provide: DRIZZLE, useValue: mockDb },
      { provide: PlanLimitsService, useValue: { assertWithinLimit } },
      { provide: EntityReferenceService, useValue: { resolve } },
      {
        provide: ChatChannelListService,
        useValue: {
          resolveEntityChannelDisplayName: jest.fn(
            async (channel: { members?: unknown[] }) => ({ ...channel, members: channel.members ?? [] }),
          ),
          getMembershipId: jest.fn().mockResolvedValue(10),
        },
      },
    ],
  }).compile();

  return {
    service: module.get(ChatChannelsService),
    findFirst,
    insert,
    txInsert,
    returning,
    resolve,
    transaction,
    assertWithinLimit,
    order,
    txExecute,
    get transactionArg() {
      return harness.transactionArg;
    },
  };
}

describe("entity channel — the GET is a read and only the POST writes", () => {
  it("performs zero inserts when the record has no channel yet", async () => {
    const h = await buildHarness();
    h.findFirst.mockResolvedValue(null);

    await expect(h.service.getEntityChannel("project", "42", actor)).resolves.toBeNull();

    expect(h.insert).not.toHaveBeenCalled();
    expect(h.txInsert).not.toHaveBeenCalled();
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("performs zero inserts when the record already has a channel", async () => {
    const h = await buildHarness();
    h.findFirst.mockResolvedValue(CHANNEL_ROW);

    const channel = await h.service.getEntityChannel("project", "42", actor);

    expect(channel).toMatchObject({ id: 7, entityId: "42" });
    expect(h.insert).not.toHaveBeenCalled();
    expect(h.txInsert).not.toHaveBeenCalled();
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("returns null rather than 404 for a readable record with no channel, so the screen can offer to create one", async () => {
    const h = await buildHarness();
    h.findFirst.mockResolvedValue(null);

    await expect(h.service.getEntityChannel("project", "42", actor)).resolves.toBeNull();
  });

  it("hides an existing private channel from a non-member read", async () => {
    const h = await buildHarness();
    h.findFirst.mockResolvedValue(ORPHANED_CHANNEL_ROW);

    await expect(h.service.getEntityChannel("project", "42", actor)).resolves.toBeNull();
    expect(h.transaction).not.toHaveBeenCalled();
  });
});

describe("entity channel — the entity ACL resolves before any channel table is touched", () => {
  it("404s the read and never queries chatChannels for an unresolvable reference", async () => {
    const h = await buildHarness();
    h.resolve.mockResolvedValue([{ status: "unresolved" }]);

    await expect(h.service.getEntityChannel("project", "42", actor)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(h.findFirst).not.toHaveBeenCalled();
    expect(h.insert).not.toHaveBeenCalled();
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("404s the create and never queries or writes chatChannels for an unresolvable reference", async () => {
    const h = await buildHarness();
    h.resolve.mockResolvedValue([{ status: "unresolved" }]);

    await expect(h.service.createEntityChannel("project", "42", actor)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(h.findFirst).not.toHaveBeenCalled();
    expect(h.insert).not.toHaveBeenCalled();
    expect(h.txInsert).not.toHaveBeenCalled();
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("404s an empty resolution array identically, so an adapter that claims no type is not an oracle", async () => {
    const h = await buildHarness();
    h.resolve.mockResolvedValue([]);

    await expect(h.service.createEntityChannel("project", "42", actor)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(h.transaction).not.toHaveBeenCalled();
  });
});

describe("entity channel — create is race-safe and quota-admitted", () => {
  it("reports created=true and inserts the creator as ADMIN when it wins the insert", async () => {
    const h = await buildHarness();
    h.findFirst.mockResolvedValueOnce(null).mockResolvedValue(CHANNEL_ROW);
    h.returning.mockResolvedValue([{ id: 7 }]);

    const result = await h.service.createEntityChannel("project", "42", actor);

    expect(result.created).toBe(true);
    expect(result.channel).toMatchObject({ id: 7 });
    expect(h.txInsert).toHaveBeenCalledTimes(2);
  });

  it("the conflict loser gets no row from returning() and still returns the committed channel", async () => {
    const h = await buildHarness();
    h.findFirst.mockResolvedValueOnce(null).mockResolvedValue(CHANNEL_ROW);
    h.returning.mockResolvedValue([]);

    const result = await h.service.createEntityChannel("project", "42", actor);

    expect(result.created).toBe(false);
    expect(result.channel).toMatchObject({ id: 7, entityId: "42" });
    expect(h.txInsert).toHaveBeenCalledTimes(1);
  });

  it("returns the existing channel with created=false without opening a transaction", async () => {
    const h = await buildHarness();
    h.findFirst.mockResolvedValue(CHANNEL_ROW);

    const result = await h.service.createEntityChannel("project", "42", actor);

    expect(result.created).toBe(false);
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("joins an existing entity channel when the caller can read the entity but is not a member", async () => {
    const h = await buildHarness();
    h.findFirst.mockResolvedValueOnce(ORPHANED_CHANNEL_ROW).mockResolvedValue(CHANNEL_ROW);

    const result = await h.service.createEntityChannel("project", "42", actor);

    expect(result.created).toBe(false);
    expect(result.channel).toMatchObject({ id: 7, entityId: "42" });
    expect(h.insert).toHaveBeenCalledTimes(1);
    expect(h.transaction).not.toHaveBeenCalled();
    // A joiner starts caught up: without a cursor the whole history counted as unread.
    const joined = h.insert.mock.results[0]?.value.values.mock.calls[0]?.[0] as { lastReadPosition?: SQL };
    expect(new PgDialect().sqlToQuery(joined.lastReadPosition as SQL).sql).toContain('"message_count"');
  });

  it("charges the same chatChannels plan limit ordinary channel creation uses", async () => {
    const h = await buildHarness();
    h.findFirst.mockResolvedValueOnce(null).mockResolvedValue(CHANNEL_ROW);

    await h.service.createEntityChannel("project", "42", actor);

    expect(h.assertWithinLimit).toHaveBeenCalledTimes(1);
    expect(h.assertWithinLimit.mock.calls[0]?.[0]).toBe("org1");
    expect(h.assertWithinLimit.mock.calls[0]?.[1]).toBe("chatChannels");
    expect(h.assertWithinLimit.mock.calls[0]?.[2]).toBe(1);
  });

  it("admits through the creating transaction, so the count cannot be read outside the write it guards", async () => {
    const h = await buildHarness();
    h.findFirst.mockResolvedValueOnce(null).mockResolvedValue(CHANNEL_ROW);

    await h.service.createEntityChannel("project", "42", actor);

    const executor = h.assertWithinLimit.mock.calls[0]?.[3];
    expect(executor).toBe(h.transactionArg);
    expect(executor).not.toBeUndefined();
  });

  it("admits BEFORE the insert, so a refusal writes no channel row", async () => {
    const h = await buildHarness();
    h.findFirst.mockResolvedValueOnce(null).mockResolvedValue(CHANNEL_ROW);

    await h.service.createEntityChannel("project", "42", actor);

    expect(h.order).toEqual(["lockQuota", "assertWithinLimit", "insert", "insert"]);
  });

  it("BITE: takes the per-org quota advisory lock BEFORE it counts, so two racers serialize", async () => {
    const h = await buildHarness();
    h.findFirst.mockResolvedValueOnce(null).mockResolvedValue(CHANNEL_ROW);

    await h.service.createEntityChannel("project", "42", actor);

    expect(h.order.indexOf("lockQuota")).toBe(0);
    expect(h.order.indexOf("lockQuota")).toBeLessThan(h.order.indexOf("assertWithinLimit"));
    const locked = h.txExecute.mock.calls.length;
    expect(locked).toBe(1);
  });

  it("the last slot refuses the create and writes nothing", async () => {
    const h = await buildHarness();
    h.findFirst.mockResolvedValue(null);
    h.assertWithinLimit.mockRejectedValue(new QuotaExceeded());

    await expect(h.service.createEntityChannel("project", "42", actor)).rejects.toBeInstanceOf(
      QuotaExceeded,
    );

    expect(h.txInsert).not.toHaveBeenCalled();
  });

  it("two racing creators at the last slot cannot both insert — the loser's admission is refused", async () => {
    const h = await buildHarness();
    h.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue(CHANNEL_ROW);
    h.assertWithinLimit
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new QuotaExceeded());

    const settled = await Promise.allSettled([
      h.service.createEntityChannel("project", "42", actor),
      h.service.createEntityChannel("project", "43", actor),
    ]);

    expect(settled.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(h.order.filter((step) => step === "insert")).toHaveLength(2);
  });

  it("the GET lookup is never charged, so reading an existing record channel stays free", async () => {
    const h = await buildHarness();
    h.findFirst.mockResolvedValue(CHANNEL_ROW);

    await h.service.getEntityChannel("project", "42", actor);
    await h.service.createEntityChannel("project", "42", actor);

    expect(h.assertWithinLimit).not.toHaveBeenCalled();
  });

  it("refuses to create for an actor with no organization membership", async () => {
    const h = await buildHarness();
    h.findFirst.mockResolvedValue(null);

    await expect(
      h.service.createEntityChannel("project", "42", { orgId: "org1", userId: "user1", isOrgOwner: false }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("getOrCreateEntityChannel still creates on demand for a server-initiated caller", async () => {
    const h = await buildHarness();
    h.findFirst.mockResolvedValueOnce(null).mockResolvedValue(CHANNEL_ROW);

    const channel = await h.service.getOrCreateEntityChannel("project", "42", actor);

    expect(channel).toMatchObject({ id: 7 });
    expect(h.transaction).toHaveBeenCalledTimes(1);
  });
});

describe("entity channel — route exposure", () => {
  it("keeps the lookup on the read key", () => {
    expect(
      Reflect.getMetadata(REQUIRE_PERMISSION, ChatChannelsController.prototype.getByEntity),
    ).toBe("chat:channels:read");
  });

  it("gates the create on chat:channels:write, so a read-only principal cannot write rows", () => {
    expect(
      Reflect.getMetadata(REQUIRE_PERMISSION, ChatChannelsController.prototype.createByEntity),
    ).toBe("chat:channels:write");
  });
});
