import { BadRequestException } from "@nestjs/common";
import { EnterpriseQuotesService } from "./enterprise-quotes.service";
import type { PlanLimitsService } from "./plan-limits.service";
import type { Db } from "../../../db/drizzle.module";

const ORG = "org-1";

function makeDb(quote: Record<string, unknown> | undefined) {
  return {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue(quote ? [{ quote, dealId: null, dealName: null, clientId: null, clientName: null, approverName: null }] : []),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
    }),
  } as unknown as Db;
}

describe("EnterpriseQuotesService — negotiated seats invalidate the entitlement cache", () => {
  it("busts the plan-limits cache when a quote is accepted", async () => {
    const bust = jest.fn().mockResolvedValue(undefined);
    const db = makeDb({
      id: 1, orgId: ORG, status: "SENT", quoteRef: "EQ-0001", approverId: null,
      negotiatedSeats: 250, pricePerSeatInPaise: 100, contractTermMonths: 12,
    });
    const service = new EnterpriseQuotesService(db, { bust } as unknown as PlanLimitsService);

    await expect(service.accept(ORG, 1)).resolves.toEqual({ success: true });

    expect(bust).toHaveBeenCalledWith(ORG);
  });

  it("does not bust the cache when the quote is not acceptable", async () => {
    const bust = jest.fn().mockResolvedValue(undefined);
    const db = makeDb({
      id: 1, orgId: ORG, status: "DRAFT", quoteRef: "EQ-0001", approverId: null,
      negotiatedSeats: 250, pricePerSeatInPaise: 100, contractTermMonths: 12,
    });
    const service = new EnterpriseQuotesService(db, { bust } as unknown as PlanLimitsService);

    await expect(service.accept(ORG, 1)).rejects.toThrow(BadRequestException);

    expect(bust).not.toHaveBeenCalled();
  });
});
