import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, join } from "node:path";
import { UnauthorizedException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import type { Redis } from "@upstash/redis";
import { exportJWK, generateKeyPair } from "jose";
import { JwtAuthGuard } from "../../../src/common/auth/jwt-auth.guard";
import { JwtKeyringService } from "../../../src/common/auth/jwt-keyring.service";
import type { MembershipStateService } from "../../../src/common/auth/membership-state.service";
import { SessionsService } from "../../../src/modules/sessions/sessions.service";
import type { Db } from "../../../src/db/drizzle.module";

const BACKEND_ROOT = resolve(__dirname, "../../..");
const USER_ID = "user-under-test";
const ORG_ID = "org-under-test";

interface SessionRow {
  id: string;
  userId: string;
  isRevoked: boolean;
  lastActive: Date;
  expiresAt: Date | null;
  userAgent: string | null;
}

/**
 * A Redis stand-in that both the revocation writer and the guard read through.
 * The tombstone is the only channel between them, which is the whole point:
 * if a revocation path forgets to write one, the guard never learns.
 */
function makeRedis() {
  const store = new Map<string, unknown>();
  /** Every write that lands on a key, with the options it carried — a TTL shows up here. */
  const writes: Array<{ key: string; value: unknown; opts?: { ex?: number; px?: number } }> = [];
  return {
    store,
    writes,
    get: jest.fn(<T>(key: string): Promise<T | null> =>
      Promise.resolve((store.has(key) ? store.get(key) : null) as T | null),
    ),
    set: jest.fn((key: string, value: unknown, opts?: { ex?: number; px?: number }) => {
      writes.push({ key, value, opts });
      store.set(key, value);
      return Promise.resolve("OK");
    }),
    // The revocation writer uses MSET, which is the reason a tombstone cannot carry a TTL.
    // The double has to land in the same `store` the guard reads, or the enforcement cases
    // below would pass on a write that never reached the guard's channel.
    mset: jest.fn((kv: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(kv)) {
        writes.push({ key, value });
        store.set(key, value);
      }
      return Promise.resolve("OK");
    }),
    zadd: jest.fn(() => Promise.resolve(1)),
    zrange: jest.fn(() => Promise.resolve([])),
    zremrangebyscore: jest.fn(() => Promise.resolve(0)),
    del: jest.fn((...keys: string[]) => {
      for (const key of keys) store.delete(key);
      return Promise.resolve(keys.length);
    }),
  };
}

type FakeRedis = ReturnType<typeof makeRedis>;

function thenable(rows: unknown[]): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  const self = (): Record<string, unknown> => chain;
  chain.from = self;
  chain.where = self;
  chain.orderBy = self;
  chain.limit = self;
  chain.then = (onOk: (value: unknown) => unknown, onErr?: (reason: unknown) => unknown) =>
    Promise.resolve(rows).then(onOk, onErr);
  return chain;
}

/** In-memory session table, only as faithful as the revocation paths need. */
function makeSessionsDb(rows: SessionRow[]) {
  const table = new Map(rows.map((row) => [row.id, { ...row }]));
  const updates: Array<{ ids: string[]; isRevoked: boolean }> = [];

  const activeRows = (): SessionRow[] => [...table.values()].filter((row) => !row.isRevoked);

  const db = {
    table,
    updates,
    query: {
      userSessions: {
        findFirst: ({ columns }: { columns?: Record<string, boolean> } = {}) => {
          void columns;
          return Promise.resolve(db.nextFindFirst);
        },
        findMany: () => Promise.resolve(activeRows().map((row) => ({ id: row.id }))),
      },
    },
    nextFindFirst: undefined as SessionRow | undefined,
    select: () => thenable(db.nextSelectRows),
    nextSelectRows: [] as Array<{ id: string }>,
    update: () => ({
      set: (values: { isRevoked?: boolean }) => ({
        where: () => {
          const targets = db.nextUpdateTargets;
          for (const id of targets) {
            const row = table.get(id);
            if (row && values.isRevoked !== undefined) row.isRevoked = values.isRevoked;
          }
          updates.push({ ids: targets, isRevoked: values.isRevoked === true });
          return Promise.resolve([]);
        },
      }),
    }),
    nextUpdateTargets: [] as string[],
    insert: () => ({ values: () => Promise.resolve([]) }),
  };

  return db;
}

async function makeKeyring(kids: string[]): Promise<JwtKeyringService> {
  const entries = await Promise.all(
    kids.map(async (kid) => {
      const { privateKey, publicKey } = await generateKeyPair("EdDSA", { extractable: true });
      return {
        kid,
        privateKey: await exportJWK(privateKey),
        publicKey: await exportJWK(publicKey),
      };
    }),
  );
  const previous = process.env.AUTH_SIGNING_KEYS;
  process.env.AUTH_SIGNING_KEYS = JSON.stringify(entries);
  const keyring = new JwtKeyringService();
  await keyring.onModuleInit();
  if (previous === undefined) delete process.env.AUTH_SIGNING_KEYS;
  else process.env.AUTH_SIGNING_KEYS = previous;
  return keyring;
}

function makeGuard(
  keyring: JwtKeyringService,
  redis: FakeRedis | null,
  databaseIsRevoked = false,
): JwtAuthGuard {
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) } as unknown as Reflector;
  const db = { select: () => thenable([{ isRevoked: databaseIsRevoked }]) } as unknown as Db;
  const membership = {
    isAccountActive: jest.fn().mockResolvedValue(true),
    resolve: jest.fn().mockResolvedValue({
      active: true,
      membershipId: 7,
      role: "MEMBER",
      isOwner: false,
    }),
  } as unknown as MembershipStateService;
  return new JwtAuthGuard(reflector, db, redis as unknown as Redis | null, membership, keyring, { moduleAvailability: async () => ({ available: true }) });
}

function contextFor(token: string): ExecutionContext {
  const req = {
    headers: { authorization: `Bearer ${token}` },
    path: "/api/protected",
    url: "/api/protected",
    method: "GET",
  };
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

async function tokenAccepted(guard: JwtAuthGuard, token: string): Promise<boolean> {
  try {
    return await guard.canActivate(contextFor(token));
  } catch {
    return false;
  }
}

function sessionRow(id: string, overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id,
    userId: USER_ID,
    isRevoked: false,
    lastActive: new Date(Date.now() - 60_000),
    expiresAt: new Date(Date.now() + 86_400_000),
    userAgent: "jest",
    ...overrides,
  };
}

describe("Revocation is enforced at token-check time, not by a database flag", () => {
  let keyring: JwtKeyringService;

  beforeAll(async () => {
    keyring = await makeKeyring(["kid-current"]);
  });

  it("CONTROL: an un-revoked session's token is accepted — the assertion can distinguish the two states", async () => {
    const redis = makeRedis();
    const token = await keyring.signToken({ sub: USER_ID, orgId: ORG_ID, sessionId: "sess-live" });
    expect(await tokenAccepted(makeGuard(keyring, redis), token)).toBe(true);
  });

  it("revokeCurrent: after logout the very same token is rejected by the guard", async () => {
    const redis = makeRedis();
    const db = makeSessionsDb([sessionRow("sess-1")]);
    const sessions = new SessionsService(db as unknown as Db, redis as unknown as Redis);
    const token = await keyring.signToken({ sub: USER_ID, orgId: ORG_ID, sessionId: "sess-1" });

    expect(await tokenAccepted(makeGuard(keyring, redis), token)).toBe(true);

    db.nextUpdateTargets = ["sess-1"];
    await sessions.revokeCurrent(USER_ID, "sess-1");

    expect(db.table.get("sess-1")?.isRevoked).toBe(true);
    await expect(makeGuard(keyring, redis).canActivate(contextFor(token))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it("revokeOne: revoking another device rejects that device's token", async () => {
    const redis = makeRedis();
    const db = makeSessionsDb([sessionRow("sess-current"), sessionRow("sess-other")]);
    const sessions = new SessionsService(db as unknown as Db, redis as unknown as Redis);
    const otherToken = await keyring.signToken({
      sub: USER_ID,
      orgId: ORG_ID,
      sessionId: "sess-other",
    });
    const currentToken = await keyring.signToken({
      sub: USER_ID,
      orgId: ORG_ID,
      sessionId: "sess-current",
    });

    db.nextFindFirst = sessionRow("sess-other");
    db.nextUpdateTargets = ["sess-other"];
    await sessions.revokeOne(USER_ID, "sess-current", "sess-other");

    expect(await tokenAccepted(makeGuard(keyring, redis), otherToken)).toBe(false);
    expect(await tokenAccepted(makeGuard(keyring, redis), currentToken)).toBe(true);
  });

  it("revokeAllForUser: every outstanding token is rejected", async () => {
    const redis = makeRedis();
    const db = makeSessionsDb([sessionRow("sess-a"), sessionRow("sess-b")]);
    const sessions = new SessionsService(db as unknown as Db, redis as unknown as Redis);
    const tokens = await Promise.all(
      ["sess-a", "sess-b"].map((sessionId) =>
        keyring.signToken({ sub: USER_ID, orgId: ORG_ID, sessionId }),
      ),
    );

    db.nextUpdateTargets = ["sess-a", "sess-b"];
    const result = await sessions.revokeAllForUser(USER_ID);
    expect(result.revokedCount).toBe(2);

    for (const token of tokens) {
      expect(await tokenAccepted(makeGuard(keyring, redis), token)).toBe(false);
    }
  });

  it("revokeAllOthers: the kept session survives and the rest do not", async () => {
    const redis = makeRedis();
    const db = makeSessionsDb([sessionRow("sess-keep"), sessionRow("sess-drop")]);
    const sessions = new SessionsService(db as unknown as Db, redis as unknown as Redis);
    const keep = await keyring.signToken({ sub: USER_ID, orgId: ORG_ID, sessionId: "sess-keep" });
    const drop = await keyring.signToken({ sub: USER_ID, orgId: ORG_ID, sessionId: "sess-drop" });

    db.nextUpdateTargets = ["sess-drop"];
    await sessions.revokeAllOthers(USER_ID, "sess-keep");

    expect(await tokenAccepted(makeGuard(keyring, redis), drop)).toBe(false);
    expect(await tokenAccepted(makeGuard(keyring, redis), keep)).toBe(true);
  });

  it("enforceMaxSessions: an evicted session's token stops working", async () => {
    const redis = makeRedis();
    const db = makeSessionsDb([
      sessionRow("sess-old"),
      sessionRow("sess-new", { lastActive: new Date() }),
    ]);
    const sessions = new SessionsService(db as unknown as Db, redis as unknown as Redis);
    db.nextSelectRows = [{ id: "sess-old" }, { id: "sess-new" }];
    db.nextUpdateTargets = ["sess-old"];

    const evicted = await keyring.signToken({ sub: USER_ID, orgId: ORG_ID, sessionId: "sess-old" });
    await sessions.enforceMaxSessions(USER_ID, 1, "sess-new");

    expect(redis.store.has("revoked:session:sess-old")).toBe(true);
    expect(await tokenAccepted(makeGuard(keyring, redis), evicted)).toBe(false);
  });

  it("publishRevocations — the shared path admin revocation uses — also stops the token", async () => {
    const redis = makeRedis();
    const db = makeSessionsDb([sessionRow("sess-admin-killed")]);
    const sessions = new SessionsService(db as unknown as Db, redis as unknown as Redis);
    const token = await keyring.signToken({
      sub: USER_ID,
      orgId: ORG_ID,
      sessionId: "sess-admin-killed",
    });

    expect(await tokenAccepted(makeGuard(keyring, redis), token)).toBe(true);
    await sessions.publishRevocations(["sess-admin-killed"]);
    expect(await tokenAccepted(makeGuard(keyring, redis), token)).toBe(false);
  });

  // Was a DEFECT SHAPE until d6ad7c4bd: an absent tombstone is a cache MISS, not an answer.
  it("a database flag alone revokes the token even with Redis up and no tombstone written", async () => {
    const redis = makeRedis();
    const token = await keyring.signToken({
      sub: USER_ID,
      orgId: ORG_ID,
      sessionId: "sess-db-only",
    });

    expect(redis.store.has("revoked:session:sess-db-only")).toBe(false);
    expect(await tokenAccepted(makeGuard(keyring, redis, true), token)).toBe(false);
  });

  it("and the deny came from the flag, not from the miss — an unrevoked session with the same miss is accepted", async () => {
    const redis = makeRedis();
    const token = await keyring.signToken({
      sub: USER_ID,
      orgId: ORG_ID,
      sessionId: "sess-db-only",
    });

    expect(redis.store.has("revoked:session:sess-db-only")).toBe(false);
    expect(await tokenAccepted(makeGuard(keyring, redis, false), token)).toBe(true);
  });

  it("the same flag DOES bite once Redis is unavailable — the database is the durable fallback, not the primary", async () => {
    const token = await keyring.signToken({
      sub: USER_ID,
      orgId: ORG_ID,
      sessionId: "sess-db-only",
    });
    await expect(
      makeGuard(keyring, null, true).canActivate(contextFor(token)),
    ).rejects.toThrow(UnauthorizedException);
    expect(await tokenAccepted(makeGuard(keyring, null, false), token)).toBe(true);
  });
});

describe("Every revocation entry point writes the tombstone the guard reads", () => {
  const REVOCATION_WRITER = "src/modules/sessions/sessions.service.ts";
  const KNOWN_WRITERS = [
    "src/modules/sessions/sessions.service.ts",
    "src/modules/users/user-profile.service.ts",
  ];

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (full.endsWith(".ts") && !full.endsWith(".spec.ts") && !full.endsWith(".d.ts"))
        out.push(full);
    }
    return out;
  }

  function revocationWriters(): string[] {
    return walk(resolve(BACKEND_ROOT, "src"))
      .filter((file) => {
        const content = readFileSync(file, "utf8");
        return content.includes(".update(userSessions)") && /isRevoked:\s*true/.test(content);
      })
      .map((file) => relative(BACKEND_ROOT, file).replace(/\\/g, "/"))
      .sort();
  }

  it("the set of files that flip user_sessions.is_revoked is the declared one — a new revocation path is noticed here", () => {
    expect(revocationWriters()).toEqual([...KNOWN_WRITERS].sort());
  });

  it("every one of them also publishes the Redis tombstone in the same method", () => {
    for (const file of revocationWriters()) {
      const source = readFileSync(resolve(BACKEND_ROOT, file), "utf8");
      const bodies = source.split(/\n {2}(?:async |private async )/).slice(1);
      const revoking = bodies.filter((body) => /isRevoked:\s*true/.test(body));

      expect({ file, revokingMethods: revoking.length > 0 }).toEqual({
        file,
        revokingMethods: true,
      });
      for (const body of revoking) {
        const method = body.slice(0, body.indexOf("("));
        expect({
          file,
          method,
          publishesTombstone: /this\.tombstone\(|publishRevocations\(/.test(body),
        }).toEqual({ file, method, publishesTombstone: true });
      }
    }
  });

  it("every revoking method in the sessions service calls tombstone()", () => {
    const source = readFileSync(resolve(BACKEND_ROOT, REVOCATION_WRITER), "utf8");
    const bodies = source.split(/\n  (?:async |private async )/).slice(1);
    const revoking = bodies.filter((body) => /isRevoked:\s*true/.test(body));

    expect(revoking.length).toBeGreaterThanOrEqual(5);
    for (const body of revoking) {
      const name = body.slice(0, body.indexOf("("));
      expect({ method: name, tombstones: /this\.tombstone\(/.test(body) }).toEqual({
        method: name,
        tombstones: true,
      });
    }
  });

  it("the tombstone is written without a TTL so an eviction policy cannot un-revoke a session", async () => {
    const redis = makeRedis();
    const db = makeSessionsDb([sessionRow("sess-ttl")]);
    const sessions = new SessionsService(db as unknown as Db, redis as unknown as Redis);

    await sessions.publishRevocations(["sess-ttl"]);

    const tombstones = redis.writes.filter((w) => w.key === "revoked:session:sess-ttl");
    expect(tombstones).toEqual([{ key: "revoked:session:sess-ttl", value: true }]);
    expect(tombstones.filter((w) => w.opts !== undefined)).toEqual([]);
  });

  it("no expiry API is applied to a tombstone key anywhere in the writer", () => {
    const source = readFileSync(resolve(BACKEND_ROOT, REVOCATION_WRITER), "utf8");
    // MSET cannot carry a TTL, which is why the property is structural rather than a
    // convention. These pin the two ways it could be reintroduced.
    expect(source).toMatch(/redis\.mset\(/);
    expect(source).toMatch(/\[`revoked:session:\$\{id\}`, true\]/);
    expect(source).not.toMatch(/redis\.set\(\s*`revoked:session:/);
    expect(source).not.toMatch(/(setex|psetex|expire|pexpire|expireat)\(/);
  });
});
