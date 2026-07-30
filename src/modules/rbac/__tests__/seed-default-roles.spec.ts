import { RolesService } from "../roles.service";

function makeInsertChain(returnValue: unknown = []) {
  const chain: Record<string, jest.Mock> = {};
  chain.values = jest.fn().mockReturnValue(chain);
  chain.onConflictDoNothing = jest.fn().mockReturnValue(chain);
  chain.onConflictDoUpdate = jest.fn().mockReturnValue(chain);
  chain.returning = jest.fn().mockResolvedValue(returnValue);
  return chain;
}

function makeSelectChain(returnValue: unknown = []) {
  const chain: Record<string, jest.Mock> = {};
  chain.from = jest.fn().mockReturnValue(chain);
  chain.limit = jest.fn().mockResolvedValue(returnValue);
  return chain;
}

function createService(existingSlugs: string[]) {
  const service = Object.create(RolesService.prototype) as RolesService;

  const txMock = {
    insert: jest.fn().mockReturnValue(makeInsertChain()),
    query: { roles: { findFirst: jest.fn().mockResolvedValue(undefined) } },
  };
  const dbMock = {
    select: jest.fn().mockReturnValue(makeSelectChain([])),
    transaction: jest.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn(txMock),
    ),
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

  const cloneTemplate = jest.fn().mockResolvedValue({ id: 2 });
  Reflect.set(service, "cloneTemplate", cloneTemplate);
  return { service, cloneTemplate };
}

describe("RolesService.seedDefaultRoles", () => {
  it("creates the starter roles that are missing and skips existing ones", async () => {
    const { service, cloneTemplate } = createService(["ENGINEERING", "HR_ADMIN"]);

    const result = await service.seedDefaultRoles("org-1");

    expect(result.skipped).toEqual(["ENGINEERING", "HR_ADMIN"]);
    expect(result.created).toEqual([
      "SALES_REP",
      "CUSTOMER_SUPPORT",
      "DIGITAL_MARKETING",
      "ACCOUNTANT",
    ]);
    expect(cloneTemplate).toHaveBeenCalledTimes(4);
    expect(cloneTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", isOrgOwner: true }),
      { templateId: "sales_rep" },
    );
  });

  it("is a no-op when every starter role already exists", async () => {
    const { service, cloneTemplate } = createService([
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
    expect(cloneTemplate).not.toHaveBeenCalled();
  });
});
