import { SQL } from "drizzle-orm";
import { AblyService } from "src/modules/realtime/ably.service";
import { ChatRealtimeController } from "src/modules/chat/chat-realtime.controller";
import { SupportRealtimeService } from "src/modules/support/core/support-realtime.service";
import { NotificationEventService } from "src/modules/notifications/notification-event.service";
import type { ChatChannelsService } from "src/modules/chat/chat-channels.service";
import type { AccessService } from "src/modules/access/access.service";
import type { Db } from "src/db/drizzle.module";
import type { CurrentUserContext } from "src/common/auth/backend-claims";
import type { DataScope } from "src/modules/access/access.types";

/**
 * Realtime capability must be tenant-checked when the token is GRANTED, not only
 * when a client subscribes. A capability document is a bearer grant: once minted
 * it is presented straight to Ably, and nothing in this system sees the subscribe.
 *
 * The pre-existing coverage for this property was static — source-text regexes
 * over the three minting files. That cannot see what a caller actually receives,
 * so it would keep passing if the capability map were built correctly and then
 * widened, and it never exercised the one path with real conditional logic
 * (support's per-ticket grant). This file runs the real minting code and reads
 * the real capability document.
 *
 * Ably's `createTokenRequest` signs locally, so these are offline and exact.
 */

const ORG_A = "org-a";
const ORG_B = "org-b";

const FAKE_ABLY_KEY = "aaaaaa.bbbbbb:ccccccccccccccccccccccc";

function ably(): AblyService {
  return new AblyService({ ABLY_API_KEY: FAKE_ABLY_KEY, CELL_ID: "cell-1" });
}

function actor(orgId: string, userId: string): CurrentUserContext {
  return {
    userId,
    orgId,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "session-1",
    tokenScopes: null,
    principal: { kind: "human-session", membershipId: 1, isOrgOwner: false },
  };
}

async function capabilityOf(token: { capability?: string }): Promise<Record<string, string[]>> {
  const parsed: unknown = JSON.parse(token.capability ?? "{}");
  return parsed as Record<string, string[]>;
}

function accessResolving(scope: DataScope): AccessService {
  return {
    resolveUserPermissions: async () => new Map<string, DataScope>([["support:tickets:view", scope]]),
  } as unknown as AccessService;
}

/** Column names and bound parameter values reachable from a drizzle predicate. */
function predicateShape(node: unknown, columns: string[] = [], params: unknown[] = []) {
  if (node === null || node === undefined) return { columns, params };
  if (Array.isArray(node)) {
    for (const child of node) predicateShape(child, columns, params);
    return { columns, params };
  }
  if (typeof node !== "object") return { columns, params };
  const record = node as Record<string, unknown>;
  if (typeof record.name === "string" && record.columnType !== undefined)
    columns.push(record.name);
  if (record.value !== undefined && record.encoder !== undefined) params.push(record.value);
  if (Array.isArray(record.queryChunks)) predicateShape(record.queryChunks, columns, params);
  return { columns, params };
}

/**
 * A db that records the predicate the service builds and returns rows the caller
 * is NOT entitled to. If the grant were derived from anything but that predicate,
 * the foreign rows would surface in the capability document.
 */
function recordingSupportDb(rows: Array<{ id: number }>) {
  const predicates: SQL[] = [];
  const db = {
    select: () => ({
      from: () => ({
        where: (predicate: SQL) => {
          predicates.push(predicate);
          return { limit: async () => rows };
        },
      }),
    }),
  } as unknown as Db;
  return { db, predicates };
}

describe("BOLA — chat realtime grant is minted against the caller's own tenant", () => {
  const channelsFor = (calls: Array<[string, string]>, ids: number[]): ChatChannelsService =>
    ({
      listMemberChannelIds: async (orgId: string, userId: string) => {
        calls.push([orgId, userId]);
        return ids;
      },
    }) as unknown as ChatChannelsService;

  it("EXECUTABLE: the channel list is read with the token's org and user, not the request's", async () => {
    const calls: Array<[string, string]> = [];
    const controller = new ChatRealtimeController(ably(), channelsFor(calls, [7]));
    await controller.ablyToken(actor(ORG_A, "user-1"));
    expect(calls).toEqual([[ORG_A, "user-1"]]);
  });

  it("EXECUTABLE: every capability key names the caller's org and no other", async () => {
    const controller = new ChatRealtimeController(ably(), channelsFor([], [7, 9]));
    const capability = await capabilityOf(await controller.ablyToken(actor(ORG_A, "user-1")));
    const keys = Object.keys(capability);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).toContain(`:${ORG_A}:`);
      expect(key).not.toContain(ORG_B);
    }
  });

  it("EXECUTABLE: two orgs holding the same channel ids receive disjoint grants", async () => {
    const controllerA = new ChatRealtimeController(ably(), channelsFor([], [7, 9]));
    const controllerB = new ChatRealtimeController(ably(), channelsFor([], [7, 9]));
    const a = Object.keys(await capabilityOf(await controllerA.ablyToken(actor(ORG_A, "user-1"))));
    const b = Object.keys(await capabilityOf(await controllerB.ablyToken(actor(ORG_B, "user-2"))));
    expect(a.filter((key) => b.includes(key))).toEqual([]);
  });

  it("EXECUTABLE: the grant's clientId is the token subject, never a caller-supplied value", async () => {
    const controller = new ChatRealtimeController(ably(), channelsFor([], [7]));
    const token = await controller.ablyToken(actor(ORG_A, "user-1"));
    expect(token.clientId).toBe("user-1");
  });
});

describe("BOLA — support realtime grant follows the caller's DataScope at grant time", () => {
  it("EXECUTABLE: scope all grants a wildcard confined to the caller's org", async () => {
    const { db } = recordingSupportDb([]);
    const service = new SupportRealtimeService(db, ably(), accessResolving("all"));
    const capability = await capabilityOf(await service.createTokenRequest(actor(ORG_A, "u1")));
    expect(Object.keys(capability)).toEqual([`cell:cell-1:support:${ORG_A}:*`]);
    expect(JSON.stringify(capability)).not.toContain(ORG_B);
  });

  it("EXECUTABLE: scope none grants nothing at all", async () => {
    const { db } = recordingSupportDb([{ id: 1 }, { id: 2 }]);
    const service = new SupportRealtimeService(db, ably(), accessResolving("none"));
    const capability = await capabilityOf(await service.createTokenRequest(actor(ORG_A, "u1")));
    expect(Object.keys(capability)).toEqual([]);
  });

  it("EXECUTABLE: a narrowed scope grants one channel per row the tenant-bound query returned", async () => {
    const { db, predicates } = recordingSupportDb([{ id: 11 }, { id: 12 }]);
    const service = new SupportRealtimeService(db, ably(), accessResolving("own"));
    const capability = await capabilityOf(await service.createTokenRequest(actor(ORG_A, "u1")));
    expect(Object.keys(capability).sort()).toEqual([
      `cell:cell-1:support:${ORG_A}:11`,
      `cell:cell-1:support:${ORG_A}:12`,
    ]);

    expect(predicates).toHaveLength(1);
    const { columns, params } = predicateShape(predicates[0]);
    expect(columns).toContain("org_id");
    expect(params).toContain(ORG_A);
    expect(params).not.toContain(ORG_B);
  });

  it("EXECUTABLE: the same ticket ids in another org produce a disjoint grant", async () => {
    const a = new SupportRealtimeService(recordingSupportDb([{ id: 11 }]).db, ably(), accessResolving("own"));
    const b = new SupportRealtimeService(recordingSupportDb([{ id: 11 }]).db, ably(), accessResolving("own"));
    const keysA = Object.keys(await capabilityOf(await a.createTokenRequest(actor(ORG_A, "u1"))));
    const keysB = Object.keys(await capabilityOf(await b.createTokenRequest(actor(ORG_B, "u2"))));
    expect(keysA).not.toEqual(keysB);
    expect(keysA.filter((key) => keysB.includes(key))).toEqual([]);
  });
});

describe("BOLA — the SSE stream token carries a server-side tenant, not a claimed one", () => {
  it("EXECUTABLE: the token resolves to exactly the org and user it was minted for", () => {
    const events = new NotificationEventService();
    const token = events.generateToken("user-1", ORG_A);
    expect(events.consumeToken(token)).toEqual({ userId: "user-1", orgId: ORG_A });
  });

  it("EXECUTABLE: a token minted in one org never resolves to another", () => {
    const events = new NotificationEventService();
    const tokenA = events.generateToken("user-1", ORG_A);
    const tokenB = events.generateToken("user-2", ORG_B);
    expect(events.consumeToken(tokenA)?.orgId).toBe(ORG_A);
    expect(events.consumeToken(tokenB)?.orgId).toBe(ORG_B);
  });

  it("EXECUTABLE: the token is single use, so a leaked one cannot be replayed", () => {
    const events = new NotificationEventService();
    const token = events.generateToken("user-1", ORG_A);
    expect(events.consumeToken(token)).not.toBeNull();
    expect(events.consumeToken(token)).toBeNull();
  });

  it("EXECUTABLE: an unknown token grants nothing", () => {
    const events = new NotificationEventService();
    expect(events.consumeToken("not-a-token")).toBeNull();
  });
});
