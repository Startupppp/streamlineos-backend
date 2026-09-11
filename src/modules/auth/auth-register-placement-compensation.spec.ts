import { AuthService } from "./auth.service";

const chooseRegionForNewOrg = jest.fn();
const placeOrganization = jest.fn();
const unplaceOrganization = jest.fn();
const runInNewTenantTransaction = jest.fn();
const organizationRowExists = jest.fn();

jest.mock("../../common/region/cell-admission", () => ({
  chooseRegionForNewOrg: (...args: unknown[]) => chooseRegionForNewOrg(...args),
  regionPlacementCoordinates: (choice: { region: string; cellId: string }) => ({
    region: choice.region,
    cellId: choice.cellId,
  }),
}));
jest.mock("../../common/region/placement-lookup", () => ({
  placeOrganization: (...args: unknown[]) => placeOrganization(...args),
  unplaceOrganization: (...args: unknown[]) => unplaceOrganization(...args),
}));
jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: (...args: unknown[]) =>
    runInNewTenantTransaction(...args),
  runInTenantTransaction: jest.fn(),
}));
jest.mock("../organization/core/cell-organization-state", () => ({
  organizationRowExists: (...args: unknown[]) =>
    organizationRowExists(...args),
}));

function build() {
  return new AuthService(
    { query: { users: { findFirst: jest.fn().mockResolvedValue(null) } } } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    new Proxy({}, { get: () => () => Promise.resolve(undefined) }) as never,
    {} as never,
  );
}

const input = {
  firstName: "Asha",
  lastName: "Rao",
  email: "asha@example.com",
  companyName: "Acme",
};

describe("AuthService register placement compensation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    chooseRegionForNewOrg.mockResolvedValue({
      kind: "selected",
      region: "in",
      cellId: "in-2",
      rejections: [],
    });
    unplaceOrganization.mockResolvedValue(undefined);
    organizationRowExists.mockResolvedValue(false);
  });

  it("compensates when placement reports failure", async () => {
    placeOrganization.mockRejectedValueOnce(new Error("placement failed"));

    await expect(build().register(input)).rejects.toThrow("placement failed");

    expect(unplaceOrganization).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
    );
  });

  it("persists the admitted cell and compensates a bootstrap transaction failure", async () => {
    placeOrganization.mockResolvedValueOnce(undefined);
    runInNewTenantTransaction.mockRejectedValueOnce(new Error("bootstrap failed"));

    await expect(build().register(input)).rejects.toThrow("bootstrap failed");

    expect(placeOrganization).toHaveBeenCalledWith(expect.anything(), {
      orgId: expect.any(String),
      region: "in",
      cellId: "in-2",
    });
    const placedOrgId = placeOrganization.mock.calls[0]?.[1]?.orgId;
    expect(unplaceOrganization).toHaveBeenCalledWith(
      expect.anything(),
      placedOrgId,
    );
  });

  it("retains placement when the bootstrap transaction may have committed", async () => {
    placeOrganization.mockResolvedValueOnce(undefined);
    runInNewTenantTransaction.mockRejectedValueOnce(new Error("commit outcome unknown"));
    organizationRowExists.mockResolvedValueOnce(true);

    await expect(build().register(input)).rejects.toThrow("commit outcome unknown");

    expect(unplaceOrganization).not.toHaveBeenCalled();
  });
});
