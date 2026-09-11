import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { ChatTypingService } from "./chat-typing.service";
import type { Db } from "../../db/drizzle.module";

const ATTACKER_ORG = "org-attacker";
const ATTACKER_USER = "user-attacker";
const CHANNEL_ID = 5;

function sqlValues(val: unknown, seen = new Set<object>()): unknown[] {
  if (val === null || val === undefined || typeof val === "string" || typeof val === "number" || typeof val === "boolean") return [val];
  if (Array.isArray(val)) return val.flatMap((v) => sqlValues(v, seen));
  if (typeof val !== "object" || seen.has(val as object)) return [];
  seen.add(val as object);
  const rec = val as Record<string, unknown>;
  return [
    ...(rec["queryChunks"] ? sqlValues(rec["queryChunks"], seen) : []),
    ...(Object.prototype.hasOwnProperty.call(rec, "value") ? sqlValues(rec["value"], seen) : []),
  ];
}

function makeDb(orgMemberRow?: { id: number }, channelRow?: { id: number; isPrivate: boolean }): Db {
  return {
    query: {
      chatChannels: {
        findFirst: jest.fn().mockResolvedValue(channelRow),
      },
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue(orgMemberRow),
      },
      chatChannelMembers: {
        findFirst: jest.fn().mockResolvedValue(undefined),
      },
      users: {
        findFirst: jest.fn().mockResolvedValue(undefined),
      },
    },
  } as unknown as Db;
}

beforeEach(() => jest.resetAllMocks());

/**
 * REWRITTEN 2026-09-03 — the three cases below did not model the attack they are named for.
 *
 * Every one made the caller a NON-MEMBER of the organization in their own token, which is an
 * auth-state failure, not a cross-tenant probe. A real prober is an ACTIVE member of their OWN
 * organization asking for a channel id belonging to another one — the org-membership lookup then
 * SUCCEEDS and the old code fell through to a bare `chat_channel_members` miss and answered 403.
 * The live sweep measured exactly that on both typing verbs. So the tests asserted the refusal
 * class on a path the attacker never takes, and the path the attacker does take was unasserted.
 */
describe("ChatTypingService — cross-tenant isolation (BOLA)", () => {
  it("setTyping answers NotFound — never Forbidden — for an ACTIVE member probing another org's channel", async () => {
    const db = makeDb({ id: 7 }, undefined);
    const svc = new ChatTypingService(db, null);
    const thrown = await svc.setTyping(CHANNEL_ID, ATTACKER_ORG, ATTACKER_USER).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(NotFoundException);
    expect(thrown).not.toBeInstanceOf(ForbiddenException);
  });

  it("getTyping answers NotFound — never Forbidden — for an ACTIVE member probing another org's channel", async () => {
    const db = makeDb({ id: 7 }, undefined);
    const svc = new ChatTypingService(db, null);
    const thrown = await svc.getTyping(CHANNEL_ID, ATTACKER_ORG, ATTACKER_USER).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(NotFoundException);
    expect(thrown).not.toBeInstanceOf(ForbiddenException);
  });

  it("resolves the channel under the requesting orgId, so the probe never reaches the membership table", async () => {
    const db = makeDb({ id: 7 }, undefined);
    const svc = new ChatTypingService(db, null);
    await expect(svc.setTyping(CHANNEL_ID, ATTACKER_ORG, ATTACKER_USER)).rejects.toThrow(NotFoundException);
    const channelCalls = (db.query.chatChannels.findFirst as jest.Mock).mock.calls;
    expect(channelCalls.length).toBeGreaterThan(0);
    expect(sqlValues((channelCalls[0]?.[0] as { where?: unknown })?.where)).toContain(ATTACKER_ORG);
    expect((db.query.chatChannelMembers.findFirst as jest.Mock).mock.calls).toHaveLength(0);
  });

  it("keeps 403 for a genuine same-org non-member of a channel that is not private", async () => {
    const db = makeDb({ id: 7 }, { id: CHANNEL_ID, isPrivate: false });
    const svc = new ChatTypingService(db, null);
    await expect(svc.setTyping(CHANNEL_ID, ATTACKER_ORG, ATTACKER_USER)).rejects.toThrow(ForbiddenException);
  });

  it("still refuses a caller whose token names an organization they are not active in", async () => {
    const db = makeDb(undefined, { id: CHANNEL_ID, isPrivate: false });
    const svc = new ChatTypingService(db, null);
    await expect(svc.getTyping(CHANNEL_ID, ATTACKER_ORG, ATTACKER_USER)).rejects.toThrow(ForbiddenException);
  });
});
