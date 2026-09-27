import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { KbChatHistoryService } from "./kb-chat-history.service";
import type { KbAskCitationService } from "./kb-ask-citations.service";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap(i => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

function makeFrom(wheres: unknown[]): object {
  const where = jest.fn().mockImplementation((a: unknown) => { wheres.push(a); return Object.assign(Promise.resolve([]), { orderBy: jest.fn().mockReturnValue(Object.assign(Promise.resolve([]), { limit: jest.fn().mockResolvedValue([]) })) }); });
  const self: Record<string, jest.Mock> = { where };
  self["innerJoin"] = jest.fn().mockImplementation(() => makeFrom(wheres));
  self["leftJoin"] = jest.fn().mockImplementation(() => makeFrom(wheres));
  return self;
}

function noCitationService(): KbAskCitationService {
  return {
    filterStoredCitations: jest.fn().mockResolvedValue([]),
  } as unknown as KbAskCitationService;
}

function makeUser(orgId: string, membershipId: number): CurrentUserContext {
  return {
    userId: "user-1",
    orgId,
    role: "member",
    isOrgOwner: false,
    sessionId: "sess-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(membershipId, false),
  };
}

describe("KbChatHistoryService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const MEMBERSHIP_ID = 42;
  const REVOKED_MEMBERSHIP_ID = 99;

  function makeDb(wheres: unknown[]) {
    return {
      select: jest.fn().mockImplementation(() => ({
        from: jest.fn().mockImplementation(() => makeFrom(wheres)),
      })),
    } as unknown as Db;
  }

  it("scopes chat history list to the requesting org (tenant isolation)", async () => {
    const wheres: unknown[] = [];
    const svc = new KbChatHistoryService(makeDb(wheres), noCitationService());

    await svc.list(makeUser(ATTACKER, MEMBERSHIP_ID), { limit: 20 });

    expect(wheres.length).toBeGreaterThan(0);
    const vals = wheres.flatMap(w => sqlValues(w));
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("returns chat messages for the owning org (same-tenant control)", async () => {
    const wheres: unknown[] = [];
    const svc = new KbChatHistoryService(makeDb(wheres), noCitationService());

    const result = await svc.list(makeUser(OWNER, MEMBERSHIP_ID), { limit: 20 });

    expect(result).toBeDefined();
    expect(result).toHaveProperty("messages");
  });

  it("scopes list query to the caller membershipId, not userId (revocation)", async () => {
    const wheres: unknown[] = [];
    const svc = new KbChatHistoryService(makeDb(wheres), noCitationService());

    await svc.list(makeUser(OWNER, REVOKED_MEMBERSHIP_ID), { limit: 20 });

    const vals = wheres.flatMap(w => sqlValues(w));
    expect(vals).toContain(REVOKED_MEMBERSHIP_ID);
    expect(vals).not.toContain(MEMBERSHIP_ID);
  });
});
