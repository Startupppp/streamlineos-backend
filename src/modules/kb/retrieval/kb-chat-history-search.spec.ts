import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { KbChatHistoryService } from "./kb-chat-history.service";
import type { KbAskCitationService } from "./kb-ask-citations.service";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (
    v === null ||
    v === undefined ||
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "boolean"
  )
    return [v];
  if (Array.isArray(v)) return v.flatMap((i) => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(r, "value")
      ? sqlValues(r.value, seen)
      : []),
  ];
}

function makeChain(
  rows: unknown[],
  whereCapture?: (w: unknown) => void,
): Record<string, jest.Mock> {
  const chain: Record<string, jest.Mock> = {
    from: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockImplementation((w: unknown) => {
    whereCapture?.(w);
    return chain;
  });
  chain.orderBy.mockReturnValue(chain);
  return chain;
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

function noCitationService(): KbAskCitationService {
  return {
    filterStoredCitations: jest.fn().mockResolvedValue([]),
  } as unknown as KbAskCitationService;
}

const USER = makeUser("org-abc", 7);
const now = new Date("2025-01-01T00:00:00Z");

const MATCHING_ROW = {
  id: 1,
  title: "Onboarding guide",
  createdAt: now,
  updatedAt: now,
};

describe("KbChatHistoryService — listConversations text search (S16)", () => {
  it("S16: tsvector predicate with prefix-form search term appears in the WHERE clause when q is supplied", async () => {
    const capturedWheres: unknown[] = [];
    const db = {
      select: jest.fn().mockReturnValue(
        makeChain([MATCHING_ROW], (w) => capturedWheres.push(w)),
      ),
    } as unknown as Db;
    const svc = new KbChatHistoryService(db, noCitationService());

    await svc.listConversations(USER, { limit: 10, q: "onboard" });

    const allValues = capturedWheres.flatMap((w) => sqlValues(w));
    expect(allValues).toContainEqual("onboard:*");
  });

  it("S16: matching conversation row is included in the result when the db returns it for the given q", async () => {
    const db = {
      select: jest.fn().mockReturnValue(makeChain([MATCHING_ROW])),
    } as unknown as Db;
    const svc = new KbChatHistoryService(db, noCitationService());

    const result = await svc.listConversations(USER, {
      limit: 10,
      q: "onboard",
    });

    expect(result.conversations).toHaveLength(1);
    expect(result.conversations[0].id).toBe(1);
    expect(result.conversations[0].title).toBe("Onboarding guide");
  });

  it("S16: non-matching conversation is excluded — empty result when db returns nothing for the q filter", async () => {
    const db = {
      select: jest.fn().mockReturnValue(makeChain([])),
    } as unknown as Db;
    const svc = new KbChatHistoryService(db, noCitationService());

    const result = await svc.listConversations(USER, {
      limit: 10,
      q: "irrelevant",
    });

    expect(result.conversations).toHaveLength(0);
    expect(result.nextCursor).toBeNull();
  });

  it("S16: no tsvector predicate in the WHERE clause when q is absent", async () => {
    const capturedWheres: unknown[] = [];
    const db = {
      select: jest.fn().mockReturnValue(
        makeChain([], (w) => capturedWheres.push(w)),
      ),
    } as unknown as Db;
    const svc = new KbChatHistoryService(db, noCitationService());

    await svc.listConversations(USER, { limit: 10 });

    const allValues = capturedWheres.flatMap((w) => sqlValues(w));
    const hasTsquery = allValues.some(
      (v) => typeof v === "string" && v.includes(":*"),
    );
    expect(hasTsquery).toBe(false);
  });

  it("S16: cursor keyset condition appears in the WHERE clause alongside the tsvector predicate", async () => {
    const cursorUpdatedAt = new Date("2025-01-02T00:00:00Z");
    const capturedWheres: unknown[] = [];
    let selectCallCount = 0;

    const db = {
      select: jest.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return makeChain([{ updatedAt: cursorUpdatedAt, id: 5 }]);
        }
        return makeChain([], (w) => capturedWheres.push(w));
      }),
    } as unknown as Db;

    const svc = new KbChatHistoryService(db, noCitationService());

    await svc.listConversations(USER, { limit: 10, cursor: 5, q: "onboard" });

    expect(selectCallCount).toBe(2);
    const allValues = capturedWheres.flatMap((w) => sqlValues(w));
    expect(allValues).toContainEqual("onboard:*");
    expect(allValues).toContainEqual(5);
  });
});
