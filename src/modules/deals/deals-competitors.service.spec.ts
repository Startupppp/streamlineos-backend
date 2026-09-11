import { ConflictException } from "@nestjs/common";
import { drizzlePostgresError, drizzleUniqueViolation } from "../../test/postgres-error-fixture";
import { DealsCompetitorsService } from "./deals-competitors.service";

describe("DealsCompetitorsService.create", () => {
  const orgId = "org-1";
  const dealId = 7;

  function createService(insertError: Error) {
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([{ id: dealId }]),
          }),
        }),
      }),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockRejectedValue(insertError),
        }),
      }),
    };
    return new DealsCompetitorsService(db as never);
  }

  it("answers 409 when the competitor is already tracked on the deal", async () => {
    // uq_crm_deal_competitors_deal_key, as drizzle surfaces it.
    const service = createService(drizzleUniqueViolation("uq_crm_deal_competitors_deal_key"));
    await expect(
      service.create(orgId, dealId, { competitorKey: "acme", status: "active" }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("rethrows any other database error untouched", async () => {
    const fkViolation = drizzlePostgresError("23503", "fk_crm_deal_competitors_deal");
    const service = createService(fkViolation);
    await expect(
      service.create(orgId, dealId, { competitorKey: "acme", status: "active" }),
    ).rejects.toBe(fkViolation);
  });
});
