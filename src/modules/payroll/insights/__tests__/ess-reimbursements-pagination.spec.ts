import { EssSelfServiceService } from "../ess-self-service.service";

describe("EssSelfServiceService.listReimbursements — pagination cap", () => {
  function makeSvc(listReimbursements: jest.Mock) {
    return new EssSelfServiceService(
      {} as never,
      { getActiveToggles: jest.fn().mockResolvedValue({ essAllowReimbursements: true }) } as never,
      {} as never,
      { listReimbursements } as never,
      {} as never,
      {} as never,
    );
  }

  it("caps at 100 when caller requests more", async () => {
    const listReimbursements = jest.fn().mockResolvedValue([]);
    const svc = makeSvc(listReimbursements);
    await svc.listReimbursements("org-1", "u1", null, 1, 200);
    expect(listReimbursements.mock.calls[0]?.[3]).toBeLessThanOrEqual(100);
  });

  it("passes page and capped limit to reimbursementsService", async () => {
    const listReimbursements = jest.fn().mockResolvedValue([]);
    const svc = makeSvc(listReimbursements);
    await svc.listReimbursements("org-1", "u1", null, 2, 25);
    expect(listReimbursements.mock.calls[0]?.[2]).toBe(2);
    expect(listReimbursements.mock.calls[0]?.[3]).toBe(25);
  });
});
