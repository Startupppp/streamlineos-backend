import { CrmCustomer360Service } from "./crm-customer360.service";
import type { CrmCustomer360SectionsService } from "./crm-customer360-sections.service";
import type { AccessService } from "../access/access.service";
import type { CacheService } from "../../common/cache/cache.service";

const ORG = "org-test";

function makeDb(resolveWith: unknown[] = []) {
  const chain: Record<string, unknown> = {};
  chain.select = jest.fn(() => chain);
  chain.from = jest.fn(() => chain);
  chain.where = jest.fn().mockResolvedValue(resolveWith);
  chain.orderBy = jest.fn(() => chain);
  chain.limit = jest.fn().mockResolvedValue(resolveWith);
  chain.then = jest.fn().mockResolvedValue(null);
  chain.execute = jest.fn().mockResolvedValue([]);
  return chain;
}

function makeSectionsMock() {
  const emptySection = { items: [], total: 0 };
  return {
    fetchContacts: jest.fn().mockResolvedValue(emptySection),
    fetchContactsForClient: jest.fn().mockResolvedValue(emptySection),
    fetchLeadsForOrg: jest.fn().mockResolvedValue(emptySection),
    fetchLeadsForClient: jest.fn().mockResolvedValue(emptySection),
    fetchDealsForOrg: jest.fn().mockResolvedValue(emptySection),
    fetchDealsForClient: jest.fn().mockResolvedValue(emptySection),
    fetchQuotesForOrg: jest.fn().mockResolvedValue(emptySection),
    fetchQuotesForClient: jest.fn().mockResolvedValue(emptySection),
    fetchInvoicesForOrg: jest.fn().mockResolvedValue(emptySection),
    fetchInvoicesForClient: jest.fn().mockResolvedValue(emptySection),
    fetchPaymentsForOrg: jest.fn().mockResolvedValue(emptySection),
    fetchPaymentsForClient: jest.fn().mockResolvedValue(emptySection),
    fetchSupportTicketsForOrg: jest.fn().mockResolvedValue(emptySection),
    fetchSupportTicketsForClient: jest.fn().mockResolvedValue(emptySection),
    fetchSurveysForOrg: jest.fn().mockResolvedValue(emptySection),
    fetchSurveysForClient: jest.fn().mockResolvedValue(emptySection),
    fetchProjectsForOrg: jest.fn().mockResolvedValue(emptySection),
    fetchProjectsForClient: jest.fn().mockResolvedValue(emptySection),
    fetchSignedDocumentsForOrg: jest.fn().mockResolvedValue(emptySection),
    fetchSignedDocumentsForClient: jest.fn().mockResolvedValue(emptySection),
  } as unknown as CrmCustomer360SectionsService;
}

describe("CrmCustomer360Service – permission filtering", () => {
  let svc: CrmCustomer360Service;
  let accessSvc: { resolveUserPermissions: jest.Mock };
  let sections: ReturnType<typeof makeSectionsMock>;

  beforeEach(() => {
    accessSvc = { resolveUserPermissions: jest.fn() };
    sections = makeSectionsMock();
    svc = new CrmCustomer360Service(
      makeDb() as never,
      accessSvc as unknown as AccessService,
      { cached: jest.fn().mockResolvedValue({ items: [], nextCursor: null }) } as unknown as CacheService,
      sections,
    );
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
    accessSvc.resolveUserPermissions.mockResolvedValue({
      "crm:contacts:view": "all",
      "crm:customer360:view": "all",
    });

    const localSections = makeSectionsMock();
    (localSections.fetchContacts as jest.Mock).mockResolvedValue({ items: [{ id: 1, name: "Contact 1" }], total: 1 });

    const chain: Record<string, unknown> = {};
    chain.select = jest.fn(() => chain);
    chain.from = jest.fn(() => chain);
    chain.where = jest.fn().mockResolvedValue([{ id: 1, name: "Test Co" }]);
    chain.orderBy = jest.fn(() => chain);
    chain.limit = jest.fn().mockResolvedValue([{ id: 1, name: "Test Co" }]);

    const localSvc = new CrmCustomer360Service(
      chain as never,
      accessSvc as unknown as AccessService,
      { cached: jest.fn().mockResolvedValue({ items: [], nextCursor: null }) } as unknown as CacheService,
      localSections,
    );

    const result = await localSvc.getCompany360(ORG, 1, "user-1");
    expect((result as Record<string, unknown>).contacts).toBeDefined();
  });
});
