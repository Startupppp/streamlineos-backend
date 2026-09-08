import { type INestApplication } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { signToken } from "test/helpers/sign-token";
import { MembershipStateService } from "src/common/auth/membership-state.service";
import { REDIS } from "src/common/cache/cache.service";

/**
 * Real HTTP pipeline e2e: a single Nest application is booted once per suite
 * and every case hits the actual guard chain over supertest. Because JwtAuthGuard
 * is a singleton in the DI container, its in-process revocationCache is shared
 * across all requests — exactly the property the unit tests in
 * session-revocation-enforced.spec.ts could not prove (they build a fresh guard
 * per test and therefore never exercise the positive-cache path).
 *
 * Two fakes are injected:
 *   fakeRedis — in-memory store shared by the guard's tombstone reader and the
 *               test's tombstone writer; no real Upstash needed.
 *   membership — mutable stub whose active/isAccountActive flags are flipped
 *                per case; no database read needed.
 */

const CONTROL_SESSION = randomUUID();
const SUSPENDED_SESSION = randomUUID();
const LEFT_SESSION = randomUUID();
const DEACTIVATED_SESSION = randomUUID();

function makeFakeRedis() {
  const store = new Map<string, unknown>();
  return {
    store,
    get: jest.fn((key: string): Promise<unknown> =>
      Promise.resolve(store.has(key) ? store.get(key) : null),
    ),
    set: jest.fn((key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve("OK");
    }),
    mset: jest.fn((kv: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(kv)) store.set(k, v);
      return Promise.resolve("OK");
    }),
    del: jest.fn((...keys: string[]) => {
      for (const k of keys) store.delete(k);
      return Promise.resolve(keys.length);
    }),
    zadd: jest.fn((): Promise<number> => Promise.resolve(1)),
    zrange: jest.fn((): Promise<string[]> => Promise.resolve([])),
    zremrangebyscore: jest.fn((): Promise<number> => Promise.resolve(0)),
    incr: jest.fn((): Promise<number> => Promise.resolve(0)),
    expire: jest.fn((): Promise<number> => Promise.resolve(0)),
    setnx: jest.fn((): Promise<number> => Promise.resolve(0)),
    pipeline: jest.fn(() => ({
      incr: jest.fn(),
      expire: jest.fn(),
      exec: jest.fn((): Promise<unknown[]> => Promise.resolve([])),
    })),
  };
}

type FakeRedis = ReturnType<typeof makeFakeRedis>;

interface MembershipBehavior {
  isAccountActive: boolean;
  active: boolean;
  membershipId: number | null;
  role: string;
  isOwner: boolean;
}

const MEMBERSHIP_DEFAULTS: MembershipBehavior = {
  isAccountActive: true,
  active: true,
  membershipId: 1,
  role: "MEMBER",
  isOwner: false,
};

function makeMutableMembershipStub() {
  let state: MembershipBehavior = { ...MEMBERSHIP_DEFAULTS };
  return {
    reset: () => {
      state = { ...MEMBERSHIP_DEFAULTS };
    },
    setState: (updates: Partial<MembershipBehavior>) => {
      state = { ...state, ...updates };
    },
    isAccountActive: jest.fn((_userId: string): Promise<boolean> =>
      Promise.resolve(state.isAccountActive),
    ),
    resolve: jest.fn(
      (
        _userId: string,
        _orgId: string,
      ): Promise<{ active: boolean; isOwner: boolean; role: string; membershipId: number | null }> =>
        Promise.resolve({
          active: state.active,
          isOwner: state.isOwner,
          role: state.role,
          membershipId: state.membershipId,
        }),
    ),
  };
}

type MutableMembership = ReturnType<typeof makeMutableMembershipStub>;

describe("Session revocation: live HTTP pipeline (e2e)", () => {
  let app: INestApplication;
  let fakeRedis: FakeRedis;
  let membership: MutableMembership;

  beforeAll(async () => {
    fakeRedis = makeFakeRedis();
    membership = makeMutableMembershipStub();
    app = await createE2eApp({
      overrides: [
        { provide: REDIS, useValue: fakeRedis },
        { provide: MembershipStateService, useValue: membership },
      ],
    });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    membership.reset();
    membership.isAccountActive.mockClear();
    membership.resolve.mockClear();
  });

  async function probe(sessionId: string): Promise<request.Response> {
    const token = await signToken({ sessionId });
    return request(app.getHttpServer()).get("/me").set("Authorization", `Bearer ${token}`);
  }

  it("CONTROL: a freshly issued token returns 2xx on a protected route", async () => {
    const res = await probe(CONTROL_SESSION);
    expect(res.status).toBeLessThan(400);
  });

  it("session revoked: the same token is rejected with 401 immediately after the tombstone is written", async () => {
    const res1 = await probe(CONTROL_SESSION);
    expect(res1.status).toBeLessThan(400);

    fakeRedis.store.set(`revoked:session:${CONTROL_SESSION}`, true);

    const res2 = await probe(CONTROL_SESSION);
    expect(res2.status).toBe(401);
  });

  it("membership suspended: re-requesting with the same token after suspension returns 403 ORG_MEMBERSHIP_INACTIVE", async () => {
    const res1 = await probe(SUSPENDED_SESSION);
    expect(res1.status).toBeLessThan(400);

    membership.setState({ active: false, membershipId: null });

    const res2 = await probe(SUSPENDED_SESSION);
    expect(res2.status).toBe(403);
    expect(res2.body).toMatchObject({ code: "ORG_MEMBERSHIP_INACTIVE" });
  });

  it("membership removed / LEFT: the token is refused with 403 ORG_MEMBERSHIP_INACTIVE", async () => {
    const res1 = await probe(LEFT_SESSION);
    expect(res1.status).toBeLessThan(400);

    membership.setState({ active: false, membershipId: null });

    const res2 = await probe(LEFT_SESSION);
    expect(res2.status).toBe(403);
    expect(res2.body).toMatchObject({ code: "ORG_MEMBERSHIP_INACTIVE" });
  });

  it("account deactivated: isAccountActive=false causes 401", async () => {
    membership.setState({ isAccountActive: false });

    const res = await probe(DEACTIVATED_SESSION);
    expect(res.status).toBe(401);
  });
});
