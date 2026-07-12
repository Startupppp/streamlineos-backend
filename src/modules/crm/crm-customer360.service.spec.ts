import { Test, TestingModule } from "@nestjs/testing";
import { CrmCustomer360Service } from "./crm-customer360.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { AccessService } from "../access/access.service";
import { CacheService } from "../../common/cache/cache.service";

const ORG = "org-test";

function makeDb() {
  return {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockResolvedValue([]),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    then: jest.fn().mockResolvedValue(null),
    execute: jest.fn().mockResolvedValue([]),
  };
}

describe("CrmCustomer360Service – permission filtering", () => {
  let svc: CrmCustomer360Service;
  let accessSvc: { resolveUserPermissions: jest.Mock };

  beforeEach(async () => {
    accessSvc = { resolveUserPermissions: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CrmCustomer360Service,
        { provide: DRIZZLE, useValue: makeDb() },
        { provide: AccessService, useValue: accessSvc },
        { provide: CacheService, useValue: { cached: jest.fn().mockResolvedValue({ items: [], nextCursor: null }) } },
      ],
    }).compile();

    svc = module.get(CrmCustomer360Service);
  });

  it("returns an empty object when org has no company record", async () => {
    accessSvc.resolveUserPermissions.mockResolvedValue({ "crm:contacts:view": "all", "crm:customer360:view": "all" });
    const result = await svc.getCompany360(ORG, 999, "user-1");
    expect(result).toEqual({});
  });

  it("omits deals section when caller lacks crm:deals:read", async () => {
    accessSvc.resolveUserPermissions.mockResolvedValue({ "crm:customer360:view": "all" });
    const result = await svc.getCompany360(ORG, 1, "user-1");
    expect((result as Record<string, unknown>).deals).toBeUndefined();
  });

  it("includes contacts section when caller has crm:contacts:view", async () => {
    function chainThat(resolveWith: unknown[]) {
      const chain: Record<string, unknown> = {
        from: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: () => Promise.resolve(resolveWith),
        then: (fn: (rows: unknown[]) => unknown) => Promise.resolve(fn(resolveWith)),
      };
      return chain;
    }

    let callCount = 0;
    const smartDb = {
      select: jest.fn(() => {
        callCount++;
        if (callCount === 1) return chainThat([{ id: 1, name: "Test Co" }]);
        return chainThat([]);
      }),
      execute: jest.fn().mockResolvedValue([]),
      transaction: jest.fn(),
    };

    const mod2 = await Test.createTestingModule({
      providers: [
        CrmCustomer360Service,
        { provide: DRIZZLE, useValue: smartDb },
        {
          provide: AccessService,
          useValue: {
            resolveUserPermissions: jest.fn().mockResolvedValue({
              "crm:contacts:view": "all",
              "crm:customer360:view": "all",
            }),
          },
        },
        { provide: CacheService, useValue: { cached: jest.fn().mockResolvedValue({ items: [], nextCursor: null }) } },
      ],
    }).compile();

    const localSvc = mod2.get(CrmCustomer360Service);
    const result = await localSvc.getCompany360(ORG, 1, "user-1");
    expect((result as Record<string, unknown>).contacts).toBeDefined();
  });
});
