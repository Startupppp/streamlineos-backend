import { sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { KbContentHealthService } from "./kb-content-health.service";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap((i) => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : []),
  ];
}

function makeDb() {
  const wheres: unknown[] = [];

  function makeChain(): object {
    const chain: Record<string, jest.Mock> = {
      where: jest.fn().mockImplementation((w: unknown) => {
        wheres.push(w);
        return {
          orderBy: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        };
      }),
    };
    for (const m of ["from", "select"]) {
      chain[m] = jest.fn().mockImplementation(() => makeChain());
    }
    return chain;
  }

  return {
    db: {
      select: jest.fn().mockImplementation(() => makeChain()),
    } as unknown as Db,
    wheres,
  };
}

const auth = {
  visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
};

function makeUser(orgId: string) {
  return {
    orgId,
    userId: "user-1",
    principal: { kind: "human-session", membershipId: 1 },
  } as never;
}

describe("KbContentHealthService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  afterEach(() => jest.resetAllMocks());

  it("scopes signals query to the requesting org", async () => {
    const { db, wheres } = makeDb();
    const svc = new KbContentHealthService(db, auth as never);
    await svc.signals(makeUser(ATTACKER), { signalType: "unowned", limit: 10, afterId: undefined, spaceId: undefined }).catch(() => {});
    const vals = wheres.flatMap((w) => sqlValues(w));
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("scopes stale signal query to the requesting org", async () => {
    const { db, wheres } = makeDb();
    const svc = new KbContentHealthService(db, auth as never);
    await svc.signals(makeUser(ATTACKER), { signalType: "stale", limit: 10, afterId: undefined, spaceId: undefined }).catch(() => {});
    const vals = wheres.flatMap((w) => sqlValues(w));
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });
});
