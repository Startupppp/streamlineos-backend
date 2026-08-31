import { FnfInsightsService } from "../fnf.service";

describe("FnfInsightsService.list — pagination cap forwarded to fnfService", () => {
  it("caps at 100 when caller requests more", async () => {
    const listFnf = jest.fn().mockResolvedValue([]);
    const svc = new FnfInsightsService(
      { listFnf } as never,
      {} as never,
    );
    await svc.list("org-1", "u1", true, 1, 200);
    expect(listFnf.mock.calls[0]?.[4]).toBeLessThanOrEqual(100);
  });

  it("passes page and capped limit to fnfService.listFnf", async () => {
    const listFnf = jest.fn().mockResolvedValue([]);
    const svc = new FnfInsightsService(
      { listFnf } as never,
      {} as never,
    );
    await svc.list("org-1", "u1", false, 2, 30);
    expect(listFnf.mock.calls[0]?.[3]).toBe(2);
    expect(listFnf.mock.calls[0]?.[4]).toBe(30);
  });
});
