import { Test } from "@nestjs/testing";
import { NO_TENANT_TRANSACTION } from "../../../common/tenant/no-tenant-transaction.decorator";
import { REQUIRE_PERMISSION } from "../../access/require-permission.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import { TimesheetsAiController } from "./timesheets-ai.controller";
import { TimesheetsBillingAiService } from "./timesheets-billing-ai.service";
import { PeriodsService } from "./periods.service";
import { BillingService } from "./billing.service";
import { ReportsService } from "./reports.service";

let mockTransactionActive = false;
jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: async (_db: unknown, read: () => Promise<unknown>) => {
    mockTransactionActive = true;
    try { return await read(); }
    finally { mockTransactionActive = false; }
  },
}));

const actor: CurrentUserContext = {
  userId: "user-1", orgId: "org-1", role: "MEMBER", isOrgOwner: false,
  sessionId: "session-1", tokenScopes: null, principal: humanSessionPrincipal(1, false),
};

describe("timesheets prose streams", () => {
  it.each([
    ["summarizeStream", "timesheets:entries:view"],
    ["rejectionReasonStream", "timesheets:approvals:manage"],
    ["describeEntryStream", "timesheets:entries:create"],
    ["billingNarrativeStream", "timesheets:billing:view"],
    ["reportsNarrativeStream", "timesheets:reports:view"],
  ])("%s retains its permission and opts out of the request transaction", (method, permission) => {
    const handler: unknown = Reflect.get(TimesheetsAiController.prototype, method);
    if (typeof handler !== "function") throw new Error(`Missing stream handler ${method}`);
    expect(Reflect.getMetadata(REQUIRE_PERMISSION, handler)).toBe(permission);
    expect(Reflect.getMetadata(NO_TENANT_TRANSACTION, handler)).toBe(true);
  });

  it("releases evidence reads before generation and forwards cancellation and the original output cap", async () => {
    const gateway = {
      streamTextWithUsage: jest.fn(async () => {
        expect(mockTransactionActive).toBe(false);
        return { model: "measured-model", correlationId: "capture" };
      }),
    };
    const getOverview = jest.fn(async () => {
      expect(mockTransactionActive).toBe(true);
      return { totalHours: 4, byDay: [], byProject: [] };
    });
    const module = await Test.createTestingModule({
      providers: [TimesheetsBillingAiService,
        { provide: DRIZZLE, useValue: {} },
        { provide: AiGatewayService, useValue: gateway },
        { provide: PeriodsService, useValue: {} },
        { provide: BillingService, useValue: {} },
        { provide: ReportsService, useValue: { getOverview } },
      ],
    }).compile();
    try {
      const service = module.get(TimesheetsBillingAiService);
      const signal = new AbortController().signal;
      await service.streamReportsNarrative(actor, {}, signal);
      expect(getOverview).toHaveBeenCalledWith(actor, {});
      expect(gateway.streamTextWithUsage).toHaveBeenCalledWith(expect.objectContaining({
        actor: { orgId: actor.orgId, userId: actor.userId },
        feature: "timesheets.reports-narrative", maxTokens: 500, charge: true, signal,
      }));
      getOverview.mockResolvedValueOnce({ totalHours: 0, byDay: [], byProject: [] });
      await expect(service.streamReportsNarrative(actor, {}, signal)).rejects.toThrow("No timesheet data");
      expect(gateway.streamTextWithUsage).toHaveBeenCalledTimes(1);
    } finally {
      await module.close();
    }
  });
});
