import { ForbiddenException } from "@nestjs/common";
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

function makeDb(orgMemberRow?: { id: number }): Db {
  return {
    query: {
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

describe("ChatTypingService — cross-tenant isolation (BOLA)", () => {
  it("setTyping throws ForbiddenException when caller has no membership in the requesting org (DENY)", async () => {
    const db = makeDb(undefined);
    const svc = new ChatTypingService(db, null);
    await expect(svc.setTyping(CHANNEL_ID, ATTACKER_ORG, ATTACKER_USER)).rejects.toThrow(ForbiddenException);
  });

  it("getTyping throws ForbiddenException when caller has no membership in the requesting org — cross-org isolation", async () => {
    const db = makeDb(undefined);
    const svc = new ChatTypingService(db, null);
    await expect(svc.getTyping(CHANNEL_ID, ATTACKER_ORG, ATTACKER_USER)).rejects.toThrow(ForbiddenException);
  });

  it("assertChannelMember scopes the org membership lookup to the requesting orgId — cross-org isolation", async () => {
    const db = makeDb(undefined);
    const svc = new ChatTypingService(db, null);
    await expect(svc.setTyping(CHANNEL_ID, ATTACKER_ORG, ATTACKER_USER)).rejects.toThrow(ForbiddenException);
    const findFirstCalls = (db.query.organizationMembers.findFirst as jest.Mock).mock.calls;
    expect(findFirstCalls.length).toBeGreaterThan(0);
    const arg = findFirstCalls[0]?.[0] as { where?: unknown };
    const whereVals = sqlValues(arg?.where);
    expect(whereVals).toContain(ATTACKER_ORG);
  });
});
