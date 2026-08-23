import { AccessService } from "./access.service";
import { poolTelemetry } from "../../db/pool-telemetry";
import type { Db } from "../../db/drizzle.module";
import type { CacheService } from "../../common/cache/cache.service";
import type { EntitlementsService } from "./entitlements.service";
import { makeMfaPolicyStub } from "../../../test/helpers/mfa-policy-stub";

/**
 * Every tenant transaction borrows a pooled connection through `withPoolBorrow`,
 * so `poolTelemetry.borrows` is the portable cost of an authorization check. The
 * HTTP gate cannot measure this path: it issues a hundred requests concurrently
 * and finishes well inside the five-second version window, so the cold read
 * never appears in its numbers.
 */

const COLD_RESOLUTION_BORROWS = 2;
const WARM_RESOLUTION_BORROWS = 0;

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

  const cache = {
    cached: jest.fn().mockImplementation(async (_key: string, fn: () => Promise<unknown>) => fn()),
    invalidate: jest.fn().mockResolvedValue(undefined),
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
  });

  it("is measured as a non-owner, because an owner never exercises this path", () => {
    const { membershipRow } = buildFixture();
    expect(membershipRow.isOwner).toBe(false);
  });

  it(`costs ${COLD_RESOLUTION_BORROWS} pooled connections cold`, async () => {
    const { service } = buildFixture();

    await service.resolveUserPermissions("org-cost", "user-cost");

    expect(poolTelemetry.snapshot().borrows).toBe(COLD_RESOLUTION_BORROWS);
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

  it("pays the cold cost again once the version cache has expired", async () => {
    const { service } = buildFixture();
    await service.resolveUserPermissions("org-cost", "user-cost");

    const clock = jest.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    poolTelemetry.reset();
    try {
      await service.resolveUserPermissions("org-cost", "user-cost");
    } finally {
      clock.mockRestore();
    }

    expect(poolTelemetry.snapshot().borrows).toBe(COLD_RESOLUTION_BORROWS);
  });
});
