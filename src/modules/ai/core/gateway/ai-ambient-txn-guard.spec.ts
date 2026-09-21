import { isInsideAmbientTenantTransaction } from "./ai-gateway-stream.helper";

const mockGetTenantContext = jest.fn();

jest.mock("../../../../common/tenant/tenant-context", () => ({
  getTenantContext: () => mockGetTenantContext(),
}));

describe("isInsideAmbientTenantTransaction — detects a pooled connection held across a provider call", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns false when no tenant transaction is active in the current async context", () => {
    mockGetTenantContext.mockReturnValue(undefined);
    expect(isInsideAmbientTenantTransaction()).toBe(false);
  });

  it("returns true when a tenant transaction is stored in async local storage", () => {
    mockGetTenantContext.mockReturnValue({ orgId: "org_guard_test", audience: "INTERNAL", tx: {}, afterCommit: [] });
    expect(isInsideAmbientTenantTransaction()).toBe(true);
  });
});
