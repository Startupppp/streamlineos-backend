import { RolesService } from "../roles.service";

function makeSelectChain(returnValue: unknown = []) {
  const chain: Record<string, jest.Mock> = {};
  chain.from = jest.fn().mockReturnValue(chain);
  chain.limit = jest.fn().mockResolvedValue(returnValue);
  return chain;
}

function createService(existingSlugs: string[]) {
  const service = Object.create(RolesService.prototype) as RolesService;

  const dbMock = {
    select: jest.fn().mockReturnValue(makeSelectChain([])),
    query: { roles: { findFirst: jest.fn() } },
  };

  const slugOrder = [
    "ENGINEERING",
    "SALES_REP",
    "CUSTOMER_SUPPORT",
    "DIGITAL_MARKETING",
    "HR_ADMIN",
    "ACCOUNTANT",
  ];
  let callCount = 0;
  dbMock.query.roles.findFirst.mockImplementation(() => {
    const slug = slugOrder[callCount] ?? "";
    callCount++;
    return Promise.resolve(existingSlugs.includes(slug) ? { id: 1 } : undefined);
  });

  Reflect.set(service, "db", dbMock);

  const seedFromTemplate = jest.fn().mockResolvedValue(undefined);
  Reflect.set(service, "seedFromTemplate", seedFromTemplate);

  return { service, seedFromTemplate };
}

jest.mock("../seed-system-roles", () => ({
  seedSystemRolesForOrg: jest.fn().mockResolvedValue(undefined),
}));

describe("RolesService.seedDefaultRoles", () => {
  it("creates the starter roles that are missing and skips existing ones", async () => {
    const { service, seedFromTemplate } = createService(["ENGINEERING", "HR_ADMIN"]);

    const result = await service.seedDefaultRoles("org-1");

    expect(result.skipped).toEqual(["ENGINEERING", "HR_ADMIN"]);
    expect(result.created).toEqual([
      "SALES_REP",
      "CUSTOMER_SUPPORT",
      "DIGITAL_MARKETING",
      "ACCOUNTANT",
    ]);
    expect(seedFromTemplate).toHaveBeenCalledTimes(4);
    expect(seedFromTemplate).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ id: "sales_rep" }),
    );
  });

  it("is a no-op when every starter role already exists", async () => {
    const { service, seedFromTemplate } = createService([
      "ENGINEERING",
      "SALES_REP",
      "CUSTOMER_SUPPORT",
      "DIGITAL_MARKETING",
      "HR_ADMIN",
      "ACCOUNTANT",
    ]);

    const result = await service.seedDefaultRoles("org-1");

    expect(result.created).toEqual([]);
    expect(result.skipped).toHaveLength(6);
    expect(seedFromTemplate).not.toHaveBeenCalled();
  });
});
