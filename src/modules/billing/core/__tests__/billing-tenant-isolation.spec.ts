import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../../db/drizzle.module";

jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: async <T>(_db: unknown, fn: (tx: unknown) => Promise<T>, _opts?: unknown) => fn(_db),
  runInNewTenantTransaction: async <T>(_db: unknown, _orgId: string, fn: (tx: unknown) => Promise<T>) => fn(_db),
}));

import { AiCreditsPacksService } from "../ai-credits-packs.service";
import { EnterpriseQuotesService } from "../enterprise-quotes.service";
import { MarketplaceService } from "../marketplace.service";
import { ReferralService } from "../referral.service";
import { InvoiceSnapshotService } from "../invoice-snapshot.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return [value];
  }
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];

  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value")
      ? sqlValues(record.value, seen)
      : []),
  ];
}

const ATTACKER_ORG = "org-attacker";
const OWNER_ORG = "org-owner";

describe("AiCreditsPacksService — cross-tenant isolation", () => {
  it("listTransactions returns empty results and scopes WHERE to the requesting org (cross-tenant isolation)", async () => {
    const itemsWhere = jest.fn().mockReturnValue({
      orderBy: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnValue({
          offset: jest.fn().mockResolvedValue([]),
        }),
      }),
    });
    const countWhere = jest.fn().mockResolvedValue([{ total: 0 }]);
    let selectCall = 0;
    const db = {
      select: jest.fn().mockImplementation(() => {
        selectCall++;
        const builder = {
          from: jest.fn().mockReturnThis(),
          where: selectCall === 1 ? itemsWhere : countWhere,
          orderBy: jest.fn().mockReturnThis(),
          limit: jest.fn().mockReturnThis(),
          offset: jest.fn().mockResolvedValue([]),
        };
        return builder;
      }),
    } as unknown as Db;
    const svc = new AiCreditsPacksService(db);

    const result = await svc.listTransactions(ATTACKER_ORG, 1, 10);

    expect(itemsWhere).toHaveBeenCalled();
    const predicate = itemsWhere.mock.calls[0]?.[0];
    expect(sqlValues(predicate)).toContain(ATTACKER_ORG);
    expect(sqlValues(predicate)).not.toContain(OWNER_ORG);
    expect(result.items).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("listTransactions returns items for the owning org (control — same-tenant access works)", async () => {
    const fakeItem = {
      id: 1, orgId: OWNER_ORG, type: "credit", amount: 1000, balanceAfter: 1000,
      feature: "ai", model: null, referenceId: null, createdAt: new Date(),
      userId: "u1", promptTokens: null, completionTokens: null, totalTokens: null, costUsd: null,
    };
    let selectCall = 0;
    const db = {
      select: jest.fn().mockImplementation(() => {
        selectCall++;
        return {
          from: jest.fn().mockReturnValue({
            where: selectCall === 1
              ? jest.fn().mockReturnValue({ orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockReturnValue({ offset: jest.fn().mockResolvedValue([fakeItem]) }) }) })
              : jest.fn().mockResolvedValue([{ total: 1 }]),
          }),
        };
      }),
    } as unknown as Db;
    const svc = new AiCreditsPacksService(db);

    const result = await svc.listTransactions(OWNER_ORG, 1, 10);
    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(1);
  });
});

describe("ReferralService — cross-tenant isolation", () => {
  it("listReferrals returns empty list and scopes WHERE to the requesting org (cross-tenant isolation)", async () => {
    const where = jest.fn().mockReturnValue({
      orderBy: jest.fn().mockReturnValue({
        limit: jest.fn().mockResolvedValue([]),
      }),
    });
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnThis(),
        where,
      }),
    } as unknown as Db;
    const svc = new ReferralService(db);

    const result = await svc.listReferrals(ATTACKER_ORG);

    expect(where).toHaveBeenCalled();
    const predicate = where.mock.calls[0]?.[0];
    expect(sqlValues(predicate)).toContain(ATTACKER_ORG);
    expect(sqlValues(predicate)).not.toContain(OWNER_ORG);
    expect(result).toHaveLength(0);
  });

  it("listReferrals returns referrals for the owning org (control)", async () => {
    const fakeReferral = { id: 1, referrerOrgId: OWNER_ORG, referredEmail: "x@y.com", status: "SENT" };
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([fakeReferral]),
          }),
        }),
      }),
    } as unknown as Db;
    const svc = new ReferralService(db);

    const result = await svc.listReferrals(OWNER_ORG);
    expect(result).toHaveLength(1);
  });
});

describe("MarketplaceService — cross-tenant isolation", () => {
  function makeMarketplaceDb(installsWhere: jest.Mock, appsResult: unknown[] = []) {
    let selectCall = 0;
    return {
      select: jest.fn().mockImplementation(() => {
        selectCall++;
        if (selectCall === 1) {
          return {
            from: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            orderBy: jest.fn().mockReturnThis(),
            limit: jest.fn().mockResolvedValue(appsResult),
          };
        }
        return {
          from: jest.fn().mockReturnThis(),
          where: installsWhere,
        };
      }),
    } as unknown as Db;
  }

  it("listApps scopes installation query to the requesting org (cross-tenant isolation)", async () => {
    const installsWhere = jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) });
    const db = makeMarketplaceDb(installsWhere);
    const svc = new MarketplaceService(db);

    await svc.listApps(ATTACKER_ORG);

    expect(installsWhere).toHaveBeenCalled();
    const predicate = installsWhere.mock.calls[0]?.[0];
    expect(sqlValues(predicate)).toContain(ATTACKER_ORG);
    expect(sqlValues(predicate)).not.toContain(OWNER_ORG);
  });

  it("listApps returns apps with installation data for the owning org (control)", async () => {
    const fakeApp = { id: 1, name: "App", isActive: true, sortOrder: 1 };
    const fakeInstall = { appId: 1, orgId: OWNER_ORG };
    const installsWhere = jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([fakeInstall]) });
    const db = makeMarketplaceDb(installsWhere, [fakeApp]);
    const svc = new MarketplaceService(db);

    const result = await svc.listApps(OWNER_ORG);
    expect(result).toHaveLength(1);
    expect(result[0]?.installation).toEqual(fakeInstall);
  });
});

describe("EnterpriseQuotesService — cross-tenant isolation", () => {
  it("findOne throws NotFoundException for a different org (cross-tenant isolation — returns 404 not 403)", async () => {
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnThis(),
        leftJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([]),
      }),
    } as unknown as Db;
    const svc = new EnterpriseQuotesService(db);

    await expect(svc.findOne(ATTACKER_ORG, 999)).rejects.toThrow(NotFoundException);
  });

  it("findOne returns the quote for the owning org (control)", async () => {
    const fakeRow = {
      enterprise_quotes: {
        id: 1, orgId: OWNER_ORG, status: "PENDING", ref: "EQ-0001", approverId: null,
        negotiatedSeats: 10, pricePerSeatInPaise: 100, contractTermMonths: 12,
      },
      deals: null,
      client_accounts: null,
      users: null,
    };
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnThis(),
        leftJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([fakeRow]),
      }),
    } as unknown as Db;
    const svc = new EnterpriseQuotesService(db);

    const result = await svc.findOne(OWNER_ORG, 1);
    expect(result.orgId).toBe(OWNER_ORG);
  });
});

describe("InvoiceSnapshotService — cross-tenant isolation", () => {
  it("getSnapshot throws NotFoundException for a different org (cross-tenant isolation — returns 404 not 403)", async () => {
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([]),
      }),
    } as unknown as Db;
    const svc = new InvoiceSnapshotService(db);

    await expect(svc.getSnapshot(ATTACKER_ORG, 999)).rejects.toThrow(NotFoundException);
  });

  it("getSnapshot returns snapshot for the owning org (control)", async () => {
    const fakeHeader = {
      id: 1, orgId: OWNER_ORG, invoiceNumber: "INV-001", totalMinor: 1000, currency: "INR",
      subscriptionId: null, sellerName: null, sellerAddress: null, sellerTaxIds: null,
      buyerName: null, buyerAddress: null, buyerTaxIds: null, placeOfSupply: null,
      taxBehavior: "EXCLUSIVE", subtotalMinor: 800, taxAmountMinor: 200,
      fxRateMicro: null, fxRateSource: null, fxRateCapturedAt: null,
      status: "ISSUED", issuedAt: new Date(), paidAt: null, voidedAt: null,
    };
    let selectCallCount = 0;
    const db = {
      select: jest.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return {
            from: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            limit: jest.fn().mockResolvedValue([fakeHeader]),
          };
        }
        return {
          from: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockResolvedValue([]),
        };
      }),
    } as unknown as Db;
    const svc = new InvoiceSnapshotService(db);

    const result = await svc.getSnapshot(OWNER_ORG, 1);
    expect(result.invoiceNumber).toBe("INV-001");
  });
});
