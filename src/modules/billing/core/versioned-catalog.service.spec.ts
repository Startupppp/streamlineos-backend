import { MODULE_METADATA } from "@nestjs/common/constants";
import { Test } from "@nestjs/testing";
import type { Provider } from "@nestjs/common";
import { CacheService } from "../../../common/cache/cache.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { BillingModule } from "./billing.module";
import { VersionedCatalogService } from "./versioned-catalog.service";

const registerAfterCommit = jest.fn<boolean, [() => Promise<void> | void]>();

jest.mock("../../../common/tenant/tenant-context", () => ({
  registerAfterCommit: (hook: () => Promise<void> | void) => registerAfterCommit(hook),
}));

function billingModuleMetadata(key: string): unknown[] {
  const value: unknown = Reflect.getMetadata(key, BillingModule);
  return Array.isArray(value) ? value : [];
}

function makeCache(): CacheService {
  return {
    cached: jest.fn().mockImplementation(async (_key: string, fn: () => Promise<unknown>) => fn()),
    set: jest.fn().mockResolvedValue(undefined),
    invalidate: jest.fn().mockResolvedValue(undefined),
  } as unknown as CacheService;
}

describe("VersionedCatalogService — reachable through Nest DI", () => {
  it("is listed in BillingModule providers, so the container can instantiate it", () => {
    expect(billingModuleMetadata(MODULE_METADATA.PROVIDERS)).toContain(VersionedCatalogService);
  });

  it("is exported by BillingModule, so another module can inject it", () => {
    expect(billingModuleMetadata(MODULE_METADATA.EXPORTS)).toContain(VersionedCatalogService);
  });

  it("resolves from the container using only what BillingModule registers", async () => {
    const registered = billingModuleMetadata(MODULE_METADATA.PROVIDERS).filter(
      (provider) => provider === VersionedCatalogService,
    ) as Provider[];

    const moduleRef = await Test.createTestingModule({
      providers: [
        ...registered,
        { provide: DRIZZLE, useValue: { execute: jest.fn() } },
        { provide: CacheService, useValue: makeCache() },
      ],
    }).compile();

    expect(moduleRef.get(VersionedCatalogService)).toBeInstanceOf(VersionedCatalogService);
  });
});

describe("VersionedCatalogService — the entitlement snapshot is busted after commit", () => {
  let cache: CacheService;
  let service: VersionedCatalogService;

  function makeInsertingDb() {
    const onConflictDoUpdate = jest.fn().mockResolvedValue(undefined);
    const values = jest.fn().mockReturnValue({ onConflictDoUpdate });
    return { insert: jest.fn().mockReturnValue({ values }), execute: jest.fn() };
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    cache = makeCache();
    const moduleRef = await Test.createTestingModule({
      providers: [
        VersionedCatalogService,
        { provide: DRIZZLE, useValue: makeInsertingDb() },
        { provide: CacheService, useValue: cache },
      ],
    }).compile();
    service = moduleRef.get(VersionedCatalogService);
  });

  it("defers the bust to the after-commit hook rather than busting inside the transaction", async () => {
    let hook: (() => Promise<void> | void) | null = null;
    registerAfterCommit.mockImplementation((candidate) => {
      hook = candidate;
      return true;
    });

    await service.upsertOrgEntitlementOverride("org1", "seats", 25, "user1", "negotiated");

    expect(registerAfterCommit).toHaveBeenCalledTimes(1);
    expect(cache.invalidate).not.toHaveBeenCalled();

    await hook!();
    expect(cache.invalidate).toHaveBeenCalledWith("billing:ent-overrides:org1");
  });

  it("busts inline when there is no ambient transaction to defer to", async () => {
    registerAfterCommit.mockReturnValue(false);

    await service.upsertOrgEntitlementOverride("org1", "seats", 25, "user1", "negotiated");

    expect(cache.invalidate).toHaveBeenCalledWith("billing:ent-overrides:org1");
  });
});

describe("VersionedCatalogService — Redis outage: fails closed, not open", () => {
  it("propagates a cache error rather than returning empty entitlements (which would grant unlimited access)", async () => {
    const brokenCache = {
      cached: jest.fn().mockRejectedValue(new Error("Redis connection refused")),
      set: jest.fn(),
      invalidate: jest.fn(),
    } as unknown as CacheService;

    const db = { select: jest.fn(), execute: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        VersionedCatalogService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: brokenCache },
      ],
    }).compile();

    const svc = moduleRef.get(VersionedCatalogService);
    await expect(svc.resolveOrgEntitlements("org1")).rejects.toThrow("Redis connection refused");
  });

  it("calls the cache with the per-org key so a Redis fallthrough fetches the right org's data", async () => {
    const capturedArgs: unknown[] = [];
    const fallthroughCache = {
      cached: jest.fn().mockImplementation(async (key: string, fn: () => Promise<unknown>) => {
        capturedArgs.push(key);
        return fn();
      }),
      set: jest.fn(),
      invalidate: jest.fn(),
    } as unknown as CacheService;

    const db = { select: jest.fn(), execute: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        VersionedCatalogService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: fallthroughCache },
      ],
    }).compile();

    const svc = moduleRef.get(VersionedCatalogService);
    await svc.resolveOrgEntitlements("org1").catch(() => undefined);

    expect(capturedArgs[0]).toBe("billing:ent-overrides:org1");
  });
});
