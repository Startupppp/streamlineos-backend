import { AccessService } from "./access.service";
import { poolTelemetry } from "../../db/pool-telemetry";
import type { Db } from "../../db/drizzle.module";
import type { CacheService } from "../../common/cache/cache.service";
import type { EntitlementsService } from "./entitlements.service";
import { makeMfaPolicyStub } from "../../../test/helpers/mfa-policy-stub";
import { accessVersionChannel } from "../../common/rbac/access-version-channel";

/**
 * Every tenant transaction borrows a pooled connection through `withPoolBorrow`,
 * so `poolTelemetry.borrows` is the portable cost of an authorization check. The
 * HTTP gate cannot measure this path at all — it finishes inside the version
 * window, so the version read never appears in its numbers.
 *
 * The version is now read from the durable row once per bump across the whole
 * fleet rather than once per instance per backstop expiry, which is the gap
 * between the first two constants and the point of the change.
 */
const FIRST_RESOLUTION_BORROWS = 2;
const STEADY_STATE_COLD_BORROWS = 1;
const WARM_RESOLUTION_BORROWS = 0;
const BORROWS_WITHOUT_SHARED_CACHE = 2;

function makeSelectChain(rows: unknown[]): Record<string, jest.Mock> {
  const chain: Record<string, jest.Mock> = {
    from: jest.fn(),
    where: jest.fn().mockResolvedValue(rows),
    innerJoin: jest.fn(),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  return chain;
}

interface CostFixture {
  service: AccessService;
  membershipRow: { isOwner: boolean; status: string; id: number };
}

function buildFixture(): CostFixture {
  const membershipRow = { isOwner: false, status: "ACTIVE", id: 1 };

  const db: Record<string, unknown> = {
    query: {
      accessVersions: { findFirst: jest.fn().mockResolvedValue({ permissionsVersion: 7 }) },
      organizationMembers: { findFirst: jest.fn().mockResolvedValue(membershipRow) },
    },
    select: jest.fn().mockImplementation(() => makeSelectChain([])),
    execute: jest.fn().mockResolvedValue(undefined),
  };
  // A bare `jest.fn()` here never runs its callback, which would silently void
  // every borrow this spec counts.
  db["transaction"] = jest
    .fn()
    .mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(db));

  const shared = new Map<string, unknown>();
  const cache = {
    cached: jest.fn().mockImplementation(async (_key: string, fn: () => Promise<unknown>) => fn()),
    invalidate: jest.fn().mockImplementation((key: string) => {
      shared.delete(key);
      return Promise.resolve();
    }),
    get: jest.fn().mockImplementation((key: string) => Promise.resolve(shared.get(key) ?? null)),
    set: jest.fn().mockImplementation((key: string, value: unknown) => {
      shared.set(key, value);
      return Promise.resolve();
    }),
  };

  const entitlements = {
    isModuleEnabled: jest.fn().mockResolvedValue(true),
    isCoreModule: jest.fn().mockReturnValue(false),
    getModuleMap: jest.fn().mockResolvedValue({}),
    getEffectiveModuleMap: jest.fn().mockResolvedValue({}),
  };

  return {
    membershipRow,
    service: new AccessService(
      db as unknown as Db,
      cache as unknown as CacheService,
      entitlements as unknown as EntitlementsService,
      makeMfaPolicyStub(),
    ),
  };
}

describe("AccessService.resolveUserPermissions — transaction cost", () => {
  beforeEach(() => {
    poolTelemetry.reset();
    accessVersionChannel.reset();
  });

  afterEach(() => {
    accessVersionChannel.reset();
  });

  it("is measured as a non-owner, because an owner never exercises this path", () => {
    const { membershipRow } = buildFixture();
    expect(membershipRow.isOwner).toBe(false);
  });

  it(`costs ${FIRST_RESOLUTION_BORROWS} pooled connections on the first resolution after a bump`, async () => {
    const { service } = buildFixture();
    service.onModuleInit();

    await service.resolveUserPermissions("org-cost", "user-cost");

    expect(poolTelemetry.snapshot().borrows).toBe(FIRST_RESOLUTION_BORROWS);
    service.onModuleDestroy();
  });

  it(`costs ${BORROWS_WITHOUT_SHARED_CACHE} pooled connections every time when the shared cache is unavailable`, async () => {
    const { service } = buildFixture();

    await service.resolveUserPermissions("org-cost", "user-cost");
    poolTelemetry.reset();
    const clock = jest.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    try {
      await service.resolveUserPermissions("org-cost", "user-cost");
    } finally {
      clock.mockRestore();
    }

    expect(poolTelemetry.snapshot().borrows).toBe(BORROWS_WITHOUT_SHARED_CACHE);
  });

  it(`costs ${WARM_RESOLUTION_BORROWS} pooled connections warm`, async () => {
    const { service } = buildFixture();
    await service.resolveUserPermissions("org-cost", "user-cost");

    poolTelemetry.reset();
    await service.resolveUserPermissions("org-cost", "user-cost");

    expect(poolTelemetry.snapshot().borrows).toBe(WARM_RESOLUTION_BORROWS);
  });

  it("resolves the same permissions warm as it did cold", async () => {
    const { service } = buildFixture();

    const cold = await service.resolveUserPermissions("org-cost", "user-cost");
    const warm = await service.resolveUserPermissions("org-cost", "user-cost");

    expect(Array.from(warm.keys()).sort()).toEqual(Array.from(cold.keys()).sort());
  });

  it(`costs ${STEADY_STATE_COLD_BORROWS} pooled connection once the local backstop expires and the shared value is warm`, async () => {
    const { service } = buildFixture();
    service.onModuleInit();
    await service.resolveUserPermissions("org-cost", "user-cost");

    const clock = jest.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    poolTelemetry.reset();
    try {
      await service.resolveUserPermissions("org-cost", "user-cost");
    } finally {
      clock.mockRestore();
      service.onModuleDestroy();
    }

    expect(poolTelemetry.snapshot().borrows).toBe(STEADY_STATE_COLD_BORROWS);
  });

  it("re-reads the version after a bump rather than serving the cached one", async () => {
    const { service } = buildFixture();
    service.onModuleInit();
    const before = await service.resolveUserPermissions("org-cost", "user-cost");

    await accessVersionChannel.publish("org-cost");
    const after = await service.resolveUserPermissions("org-cost", "user-cost");

    expect(Array.from(after.keys()).sort()).toEqual(Array.from(before.keys()).sort());
    expect(poolTelemetry.snapshot().borrows).toBeGreaterThan(WARM_RESOLUTION_BORROWS);
    service.onModuleDestroy();
  });
});
