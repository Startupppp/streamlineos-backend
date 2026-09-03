import { NotFoundException } from "@nestjs/common";
import { OrganizationSettingsService } from "./organization-settings.service";
import type { Db } from "../../../db/drizzle.module";
import type { AuditService } from "../../../common/audit/audit.service";
import type { CacheService } from "../../../common/cache/cache.service";
import type { MfaPolicyService } from "../../access/mfa-policy.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

describe("OrganizationSettingsService — custom domains refuse a foreign id with 404", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";
  const USER = "user-1";

  const audit = { log: jest.fn() } as unknown as AuditService;
  const cache = { del: jest.fn(), delByPrefix: jest.fn() } as unknown as CacheService;
  const mfaPolicy = {} as MfaPolicyService;

  afterEach(() => jest.resetAllMocks());

  function makeService(db: Db) {
    return new OrganizationSettingsService(db, audit, cache, mfaPolicy);
  }

  it("verifyCustomDomain answers 404, not 400, when the domain is not in the caller's org", async () => {
    const update = jest.fn();
    const db = {
      query: { orgCustomDomains: { findFirst: jest.fn().mockResolvedValue(undefined) } },
      update,
    } as unknown as Db;

    await expect(makeService(db).verifyCustomDomain(ATTACKER_ORG, USER, "d-1")).rejects.toThrow(NotFoundException);
    expect(update).not.toHaveBeenCalled();
  });

  it("verifyCustomDomain scopes the verified-at write to the caller's org (control)", async () => {
    const where = jest.fn().mockResolvedValue(undefined);
    const set = jest.fn().mockReturnValue({ where });
    const db = {
      query: { orgCustomDomains: { findFirst: jest.fn().mockResolvedValue({ id: "d-1", orgId: OWNER_ORG }) } },
      update: jest.fn().mockReturnValue({ set }),
    } as unknown as Db;

    await expect(makeService(db).verifyCustomDomain(OWNER_ORG, USER, "d-1")).resolves.toEqual({
      success: true,
      verified: true,
    });
    expect(where).toHaveBeenCalledTimes(1);
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(OWNER_ORG);
  });

  it("removeCustomDomain answers 404 rather than a success when nothing was deleted", async () => {
    const returning = jest.fn().mockResolvedValue([]);
    const where = jest.fn().mockReturnValue({ returning });
    const db = { delete: jest.fn().mockReturnValue({ where }) } as unknown as Db;

    await expect(makeService(db).removeCustomDomain(ATTACKER_ORG, USER, "d-1")).rejects.toThrow(NotFoundException);
  });

  it("removeCustomDomain still succeeds when the row belonged to the caller (control)", async () => {
    const returning = jest.fn().mockResolvedValue([{ id: "d-1" }]);
    const where = jest.fn().mockReturnValue({ returning });
    const db = { delete: jest.fn().mockReturnValue({ where }) } as unknown as Db;

    await expect(makeService(db).removeCustomDomain(OWNER_ORG, USER, "d-1")).resolves.toEqual({ success: true });
  });
});
