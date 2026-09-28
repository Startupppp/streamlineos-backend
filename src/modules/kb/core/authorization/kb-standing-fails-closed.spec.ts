import * as fs from "node:fs";
import * as path from "node:path";
import type { Redis } from "@upstash/redis";
import { PgDialect } from "drizzle-orm/pg-core";
import { CacheService } from "../../../../common/cache/cache.service";
import { CacheFiller } from "../../../../common/cache/cache-fill";
import { runWithObservabilityContext } from "../../../../common/observability/observability-context";
import type { AccessService } from "../../../access/access.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { Db } from "../../../../db/drizzle.module";
import { KnowledgeAuthorizationService } from "./knowledge-authorization.service";
import { kbAclCacheKey, kbAclDimension } from "../kb-acl-cache-key";

const ORG = "org-fails-closed";
const USER = "user-fails-closed";
const MEMBERSHIP = 42;
const PERMISSIONS_VERSION = 1;

const RESTRICTED_SPACE = 11;
const PUBLIC_SPACE = 12;

interface DbState {
  roleSlugs: string[];
  projectIds: number[];
  spaces: { id: number; audience: string }[];
  memberSpaceIds: number[];
}

function defaultState(over: Partial<DbState> = {}): DbState {
  return {
    roleSlugs: [],
    projectIds: [],
    spaces: [
      { id: RESTRICTED_SPACE, audience: "internal" },
      { id: PUBLIC_SPACE, audience: "public" },
    ],
    memberSpaceIds: [],
    ...over,
  };
}

/**
 * Routed by the projection's field names rather than by call order, because the
 * standing path issues its role-slug and project reads concurrently and an
 * order-keyed double would silently answer one query with the other's rows.
 */
function makeDb(state: DbState): Db {
  const rowsFor = (fields: Record<string, unknown>): unknown[] => {
    const shape = Object.keys(fields).sort().join(",");
    if (shape === "slug") return state.roleSlugs.map((slug) => ({ slug }));
    if (shape === "id") return state.projectIds.map((id) => ({ id }));
    if (shape === "audience,id") return state.spaces;
    if (shape === "spaceId")
      return state.memberSpaceIds.map((spaceId) => ({ spaceId }));
    throw new Error(`unrouted projection: ${shape}`);
  };

  const chain = (rows: unknown[]): Record<string, unknown> => {
    const node: Record<string, unknown> = {};
    node.from = () => node;
    node.innerJoin = () => node;
    node.where = () => Promise.resolve(rows);
    node.limit = () => Promise.resolve(rows);
    return node;
  };

  return {
    select: (fields: Record<string, unknown>) => chain(rowsFor(fields)),
    selectDistinct: (fields: Record<string, unknown>) => chain(rowsFor(fields)),
    query: {
      kbPages: { findFirst: jest.fn().mockResolvedValue(undefined) },
      kbSpaces: { findFirst: jest.fn().mockResolvedValue(undefined) },
    },
  } as unknown as Db;
}

function makeAccess(holdsManage = false): AccessService {
  return {
    holds: jest.fn().mockResolvedValue(holdsManage),
    getPermissionsVersion: jest.fn().mockResolvedValue(PERMISSIONS_VERSION),
  } as unknown as AccessService;
}

function makeUser(): CurrentUserContext {
  return {
    userId: USER,
    orgId: ORG,
    role: "member",
    isOrgOwner: false,
    principal: { kind: "human-session", membershipId: MEMBERSHIP, isOrgOwner: false },
  } as unknown as CurrentUserContext;
}

function entryKey(): string {
  return kbAclCacheKey(USER, kbAclDimension(makeUser(), PERMISSIONS_VERSION));
}

let requestSequence = 0;

function inRequest<T>(fn: () => Promise<T>): Promise<T> {
  requestSequence += 1;
  return runWithObservabilityContext(
    { correlationId: `fails-closed-${String(requestSequence)}` },
    fn,
  );
}

function unreachableRedis(): Redis {
  const explode = (): Promise<never> => Promise.reject(new Error("ECONNREFUSED"));
  return {
    get: jest.fn(explode),
    set: jest.fn(explode),
    incr: jest.fn(explode),
    eval: jest.fn(explode),
    del: jest.fn(explode),
  } as unknown as Redis;
}

function healthyRedis(store: Map<string, unknown>): Redis {
  return {
    get: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: jest.fn((key: string, value: unknown, options?: { nx?: boolean }) => {
      if (options?.nx && store.has(key)) return Promise.resolve(null);
      store.set(key, value);
      return Promise.resolve("OK");
    }),
    incr: jest.fn((key: string) => {
      const next = Number(store.get(key) ?? 0) + 1;
      store.set(key, next);
      return Promise.resolve(next);
    }),
    eval: jest.fn((script: string, keys: string[], args: string[]) => {
      if (store.get(keys[0] ?? "") !== args[0]) return Promise.resolve(0);
      if (script.includes('redis.call("set"') && keys[1] !== undefined) {
        store.set(keys[1], JSON.parse(args[1] ?? "null"));
        return Promise.resolve(1);
      }
      store.delete(keys[0] ?? "");
      return Promise.resolve(1);
    }),
    del: jest.fn((...keys: string[]) => {
      for (const key of keys) store.delete(key);
      return Promise.resolve(keys.length);
    }),
  } as unknown as Redis;
}

/**
 * Answers every key except the namespace generation counter, which times out.
 * One command failing while the connection still answers is the ordinary shape
 * of an overloaded Redis, and it is the only shape in which a generation
 * fallback can serve a retired entry at all.
 */
function generationBlindRedis(store: Map<string, unknown>): Redis {
  const healthy = healthyRedis(store);
  return {
    ...healthy,
    get: jest.fn((key: string) => {
      if (key.startsWith("cache:namespace:"))
        return Promise.reject(new Error("ETIMEDOUT"));
      return Promise.resolve(store.get(key) ?? null);
    }),
  } as unknown as Redis;
}

function serviceOver(redis: Redis | null, state: DbState, holdsManage = false): {
  service: KnowledgeAuthorizationService;
  cache: CacheService;
} {
  const cache = new CacheService(redis);
  return {
    service: new KnowledgeAuthorizationService(
      makeDb(state),
      cache,
      makeAccess(holdsManage),
    ),
    cache,
  };
}

describe("KB standing fails closed when the cache cannot answer", () => {
  it("resolves the accessible-space list from the database when Redis is unreachable, so a space the actor was removed from is not in their standing", async () => {
    const { service } = serviceOver(
      unreachableRedis(),
      defaultState({ memberSpaceIds: [] }),
    );

    const standing = await inRequest(() => service.resolveStanding(makeUser()));

    expect(standing.accessibleSpaceIds).not.toContain(RESTRICTED_SPACE);
    expect(standing.isKbAdmin).toBe(false);
  });

  it("POSITIVE CONTROL — the same unreachable Redis still grants the restricted space to an actor whose space membership is intact, so the denial above is a decision and not an unreachable path", async () => {
    const { service } = serviceOver(
      unreachableRedis(),
      defaultState({ memberSpaceIds: [RESTRICTED_SPACE] }),
    );

    const standing = await inRequest(() => service.resolveStanding(makeUser()));

    expect(standing.accessibleSpaceIds).toContain(RESTRICTED_SPACE);
    expect(standing.accessibleSpaceIds).toContain(PUBLIC_SPACE);
  });

  it("keeps a revoked space out of the rendered page predicate when Redis is unreachable, so the SQL the database sees cannot match it", async () => {
    const { service } = serviceOver(
      unreachableRedis(),
      defaultState({ memberSpaceIds: [] }),
    );

    const predicate = await inRequest(() =>
      service.visiblePagePredicate(makeUser(), "view"),
    );
    const rendered = new PgDialect().sqlToQuery(predicate);

    expect(rendered.params).not.toContain(RESTRICTED_SPACE);
  });

  it("POSITIVE CONTROL — the same rendered predicate does carry an intact space membership, so the parameter assertion above is not passing on an empty parameter list", async () => {
    const { service } = serviceOver(
      unreachableRedis(),
      defaultState({ memberSpaceIds: [RESTRICTED_SPACE] }),
    );

    const predicate = await inRequest(() =>
      service.visiblePagePredicate(makeUser(), "view"),
    );
    const rendered = new PgDialect().sqlToQuery(predicate);

    expect(rendered.params).toContain(RESTRICTED_SPACE);
  });

  it("does not serve a retired generation of the accessible-space entry when the generation counter alone is unreadable, so a revoked space cannot outlive its invalidation", async () => {
    const namespace = `kb:acc-spaces:${ORG}`;
    const store = new Map<string, unknown>([
      [`${namespace}:v0:${entryKey()}`, [RESTRICTED_SPACE, PUBLIC_SPACE]],
      [`cache:namespace:${namespace}:version`, 1],
    ]);
    const { service } = serviceOver(
      generationBlindRedis(store),
      defaultState({ memberSpaceIds: [] }),
    );

    const standing = await inRequest(() => service.resolveStanding(makeUser()));

    expect(standing.accessibleSpaceIds).not.toContain(RESTRICTED_SPACE);
    expect(standing.accessibleSpaceIds).toEqual([PUBLIC_SPACE]);
  });

  it("NEGATIVE CONTROL — the retired generation-0 entry really is present and readable, so the assertion above is testing the generation fallback and not an empty store", async () => {
    const namespace = `kb:acc-spaces:${ORG}`;
    const store = new Map<string, unknown>([
      [`${namespace}:v0:${entryKey()}`, [RESTRICTED_SPACE, PUBLIC_SPACE]],
      [`cache:namespace:${namespace}:version`, 1],
    ]);
    const redis = generationBlindRedis(store);

    await expect(redis.get(`${namespace}:v0:${entryKey()}`)).resolves.toEqual([
      RESTRICTED_SPACE,
      PUBLIC_SPACE,
    ]);
    await expect(
      redis.get(`cache:namespace:${namespace}:version`),
    ).rejects.toThrow("ETIMEDOUT");
  });

  it("POSITIVE CONTROL — a healthy Redis still caches the accessible-space entry across requests, so the bypasses above are conditional and the cache has not been disabled", async () => {
    const store = new Map<string, unknown>();
    const state = defaultState({ memberSpaceIds: [RESTRICTED_SPACE] });
    const { service } = serviceOver(healthyRedis(store), state);
    const user = makeUser();

    const first = await inRequest(() => service.resolveStanding(user));
    state.memberSpaceIds = [];
    const second = await inRequest(() => service.resolveStanding(user));

    expect(first.accessibleSpaceIds).toContain(RESTRICTED_SPACE);
    expect(second.accessibleSpaceIds).toContain(RESTRICTED_SPACE);
    expect(store.has(`kb:acc-spaces:${ORG}:v0:${entryKey()}`)).toBe(true);
  });
});

describe("KB standing is not cached in CacheService, because no page-grant or space-membership write bumps permissionsVersion", () => {
  function recordingCache(): { cache: CacheService; namespaces: string[] } {
    const namespaces: string[] = [];
    const cache = {
      cachedVersioned: jest
        .fn()
        .mockImplementation(
          (ns: string, _key: string, fetcher: () => Promise<unknown>) => {
            namespaces.push(ns);
            return fetcher();
          },
        ),
      cachedVersionedWithOutcome: jest
        .fn()
        .mockImplementation(
          async (ns: string, _key: string, fetcher: () => Promise<unknown>) => {
            namespaces.push(ns);
            return { value: await fetcher(), cacheOutcome: "miss" as const };
          },
        ),
      cachedForOrg: jest
        .fn()
        .mockImplementation((_org: string, key: string, fetcher: () => Promise<unknown>) => {
          namespaces.push(key);
          return fetcher();
        }),
      cached: jest
        .fn()
        .mockImplementation((key: string, fetcher: () => Promise<unknown>) => {
          namespaces.push(key);
          return fetcher();
        }),
      invalidateNamespace: jest.fn().mockResolvedValue(undefined),
    } as unknown as CacheService;
    return { cache, namespaces };
  }

  it("reaches exactly one cache namespace while resolving standing — a second one means standing itself was cached under a key permissionsVersion cannot invalidate", async () => {
    const { cache, namespaces } = recordingCache();
    const service = new KnowledgeAuthorizationService(
      makeDb(defaultState({ memberSpaceIds: [RESTRICTED_SPACE] })),
      cache,
      makeAccess(),
    );

    await inRequest(() => service.resolveStanding(makeUser()));

    expect(namespaces).toEqual([`kb:acc-spaces:${ORG}`]);
  });

  it("every cache namespace the standing path touches is excluded from the degraded outage memo, so a new standing cache cannot be memoised through an outage", async () => {
    const { cache, namespaces } = recordingCache();
    const service = new KnowledgeAuthorizationService(
      makeDb(defaultState({ memberSpaceIds: [RESTRICTED_SPACE] })),
      cache,
      makeAccess(),
    );

    await inRequest(() => service.resolveStanding(makeUser()));

    for (const namespace of namespaces) {
      expect(
        CacheFiller.AUTHZ_KEY_MARKERS.some((marker) =>
          namespace.toLowerCase().includes(marker),
        ),
      ).toBe(true);
    }
    expect(namespaces.length).toBeGreaterThan(0);
  });

  it("NEGATIVE CONTROL — an ordinary namespace matches no authorization marker, so the exclusion above is not satisfied by every string", () => {
    expect(
      CacheFiller.AUTHZ_KEY_MARKERS.some((marker) =>
        `dashboard:stats:${ORG}`.toLowerCase().includes(marker),
      ),
    ).toBe(false);
  });

  it("an accessible-space entry survives a space-membership revocation while permissionsVersion is unchanged — the premise that a version-keyed standing entry would outlive a revocation", async () => {
    const store = new Map<string, unknown>();
    const state = defaultState({ memberSpaceIds: [RESTRICTED_SPACE] });
    const { service } = serviceOver(healthyRedis(store), state);
    const user = makeUser();

    const before = await inRequest(() => service.resolveStanding(user));
    state.memberSpaceIds = [];
    const afterRevocationWithoutInvalidation = await inRequest(() =>
      service.resolveStanding(user),
    );

    expect(before.permissionsVersion).toBe(PERMISSIONS_VERSION);
    expect(afterRevocationWithoutInvalidation.permissionsVersion).toBe(
      PERMISSIONS_VERSION,
    );
    expect(afterRevocationWithoutInvalidation.accessibleSpaceIds).toContain(
      RESTRICTED_SPACE,
    );
  });

  it("the namespace invalidation every space-membership writer performs is what ends that entry, with permissionsVersion still unchanged", async () => {
    const store = new Map<string, unknown>();
    const state = defaultState({ memberSpaceIds: [RESTRICTED_SPACE] });
    const { service } = serviceOver(healthyRedis(store), state);
    const user = makeUser();

    await inRequest(() => service.resolveStanding(user));
    state.memberSpaceIds = [];
    await service.invalidateSpaceScope(ORG);
    const after = await inRequest(() => service.resolveStanding(user));

    expect(after.permissionsVersion).toBe(PERMISSIONS_VERSION);
    expect(after.accessibleSpaceIds).not.toContain(RESTRICTED_SPACE);
  });
});

describe("every KB writer of kb_space_members drops the accessible-space namespace, because permissionsVersion does not move for a membership change", () => {
  const KB_SRC = path.resolve(__dirname, "../..");

  function productionSources(dir: string): string[] {
    const results: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...productionSources(full));
        continue;
      }
      if (
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".spec.ts")
      ) {
        results.push(full);
      }
    }
    return results;
  }

  const INVALIDATORS =
    /invalidateSpaceScope|invalidateAccessibleSpaceIds|kb:acc-spaces:/;

  function membershipWriters(): { file: string; source: string }[] {
    return productionSources(KB_SRC)
      .map((file) => ({ file, source: fs.readFileSync(file, "utf8") }))
      .filter(({ source }) =>
        /\.(insert|update|delete)\(\s*kbSpaceMembers/.test(source),
      );
  }

  it("names at least one writer, so the per-writer assertion below cannot pass on an empty set", () => {
    expect(membershipWriters().length).toBeGreaterThan(0);
  });

  it("each writer reaches an accessible-space invalidation in the same file", () => {
    const missing = membershipWriters()
      .filter(({ source }) => !INVALIDATORS.test(source))
      .map(({ file }) => path.relative(KB_SRC, file).split(path.sep).join("/"));

    expect(missing).toEqual([]);
  });

  it("NEGATIVE CONTROL — the invalidator pattern does not match a file that performs no invalidation, so the assertion above is not a tautology", () => {
    expect(
      INVALIDATORS.test("await this.db.insert(kbSpaceMembers).values(row);"),
    ).toBe(false);
  });
});
