import { OrganizationSettingsService } from "./organization-settings.service";
import { orgSettingsResponseSchema } from "./dto/organization-core-response.schemas";
import type { Db } from "../../../db/drizzle.module";

const ORG_ID = "org-1";

function orgRow() {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: ORG_ID,
    name: "Acme Inc",
    slug: "acme",
    logo: null,
    website: null,
    industry: null,
    region: null,
    timezone: "UTC",
    currency: "USD",
    fiscalYearStart: 1,
    settings: {},
    billingEmail: null,
    address: null,
    mfaEnforced: false,
    maxConcurrentSessions: null,
    ownerMembershipId: 1,
    onboardingCompletedAt: now,
    status: "ACTIVE",
    statusV2: null,
    purgeScheduledAt: null,
    purgeScheduledBy: null,
    purgeJobId: null,
    purgedAt: null,
    purgeReason: null,
    deletedAt: null,
    companySize: null,
    country: null,
    legalName: null,
    orgCode: null,
    registrationNumber: null,
    taxNumber: null,
    supportEmail: null,
    supportPhone: null,
    favicon: null,
    secondaryColor: null,
    businessHours: null,
    createdAt: now,
    updatedAt: now,
  };
}

function makeService(throughRedis: boolean) {
  const findFirst = jest.fn().mockResolvedValue(orgRow());
  const selectBuilder: Record<string, unknown> = {
    from: jest.fn(),
    where: jest.fn(),
    limit: jest.fn().mockResolvedValue([]),
  };
  (selectBuilder["from"] as jest.Mock).mockReturnValue(selectBuilder);
  (selectBuilder["where"] as jest.Mock).mockReturnValue(selectBuilder);
  const db = {
    query: { organizations: { findFirst } },
    select: jest.fn().mockReturnValue(selectBuilder),
  } as unknown as Db;
  const audit = { log: jest.fn() };
  const cache = {
    cachedForOrg: jest.fn().mockImplementation(async (_org: unknown, _key: unknown, fn: () => Promise<unknown>) => {
      const value = await fn();
      return throughRedis ? JSON.parse(JSON.stringify(value)) : value;
    }),
  };
  const mfaPolicy = { invalidateOrg: jest.fn().mockResolvedValue(undefined) };
  return new OrganizationSettingsService(db, audit as never, cache as never, mfaPolicy as never);
}

describe("OrganizationController.getSettings — the shape the read path returns", () => {
  it("satisfies orgSettingsResponseSchema on a cache MISS (fresh Date objects)", async () => {
    const svc = makeService(false);
    const result = await svc.getSettings(ORG_ID);
    const parsed = orgSettingsResponseSchema.safeParse(result);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
  });

  it("satisfies orgSettingsResponseSchema on a cache HIT (Redis JSON round-trip turns Date into string)", async () => {
    const svc = makeService(true);
    const result = await svc.getSettings(ORG_ID);
    expect(typeof (result as { createdAt: unknown } | null)?.createdAt).toBe("string");
    const parsed = orgSettingsResponseSchema.safeParse(result);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
  });
});
