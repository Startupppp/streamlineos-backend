import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { BillingEnterpriseController } from "./billing-enterprise.controller";

describe("BillingEnterpriseController analytics organization scope", () => {
  it("passes the authenticated organization to every analytics read", async () => {
    const analytics = {
      getMetrics: jest.fn().mockResolvedValue({ mrr: 10 }),
      getTimeSeriesData: jest.fn().mockResolvedValue([]),
    };
    const controller = new BillingEnterpriseController(
      {} as never,
      {} as never,
      {} as never,
      analytics as never,
      {} as never,
    );
    const user: CurrentUserContext = {
      userId: "user-a",
      orgId: "org-a",
      role: "OWNER",
      isOrgOwner: true,
      sessionId: "session-a",
      tokenScopes: null,
      principal: { kind: "human-session", membershipId: 1, isOrgOwner: true },
    };

    await expect(controller.getAnalytics({ period: "12m" }, user)).resolves.toEqual({
      metrics: { mrr: 10 },
      timeSeries: [],
    });
    expect(analytics.getMetrics).toHaveBeenCalledWith("org-a");
    expect(analytics.getTimeSeriesData).toHaveBeenCalledWith("12m", "org-a");
  });
});
