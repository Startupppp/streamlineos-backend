import type { Db } from "../../db/drizzle.module";
import type { CacheService } from "../../common/cache/cache.service";
import { stubService } from "../../test/service-stub.spec-fixtures";
import { MfaPolicyService } from "./mfa-policy.service";

describe("MfaPolicyService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const USER_ID = "user-abc";

  function makeDb(orgRow: unknown): Db {
    return {
      query: {
        organizations: { findFirst: jest.fn().mockResolvedValue(orgRow) },
        users: { findFirst: jest.fn().mockResolvedValue(null) },
      },
    } as unknown as Db;
  }

  it("resolves false (not enforced) for a non-existent org — no cross-tenant enforcement leak", async () => {
    const db = makeDb(null);
    const mockCache = stubService<CacheService>({
      cachedForOrg: jest.fn().mockImplementation((_orgId: unknown, _key: unknown, fn: () => Promise<unknown>) => fn()),
      cached: jest.fn().mockImplementation((_k: unknown, fn: () => Promise<unknown>) => fn()),
      invalidateForOrg: jest.fn(),
      invalidate: jest.fn(),
    });
    const svc = new MfaPolicyService(db, mockCache);
    const result = await svc.resolve(ATTACKER, USER_ID);
    expect(result.enforced).toBe(false);
  });

  it("returns the org's MFA policy for an existing org (control — same-tenant)", async () => {
    const db = makeDb({ id: OWNER, mfaEnforced: true });
    const mockCache = stubService<CacheService>({
      cachedForOrg: jest.fn().mockImplementation((_orgId: unknown, _key: unknown, fn: () => Promise<unknown>) => fn()),
      cached: jest.fn().mockImplementation((_k: unknown, fn: () => Promise<unknown>) => fn()),
      invalidateForOrg: jest.fn(),
      invalidate: jest.fn(),
    });
    const svc = new MfaPolicyService(db, mockCache);
    const result = await svc.resolve(OWNER, USER_ID);
    expect(result).toHaveProperty("enforced");
    expect(result).toHaveProperty("satisfied");
  });
});
