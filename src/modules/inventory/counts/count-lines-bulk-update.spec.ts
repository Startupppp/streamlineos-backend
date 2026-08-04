import { InvCycleCountsService } from "./inv-cycle-counts.service";
import { InvPhysicalAuditsService } from "./inv-physical-audits.service";

describe("inventory count line bulk updates", () => {
  it.each([
    [InvCycleCountsService, "requireCount", "getCycleCount"],
    [InvPhysicalAuditsService, "requireAudit", "getAudit"],
  ] as const)("updates all submitted lines with one database call", async (Service, guard, getter) => {
    const execute = jest.fn().mockResolvedValue(undefined);
    const cache = { invalidate: jest.fn().mockResolvedValue(undefined) };
    const service = new Service({ execute } as never, cache as never, {} as never, {} as never);
    Object.assign(service, {
      [guard]: jest.fn().mockResolvedValue({ status: "COUNTING" }),
      [getter]: jest.fn().mockResolvedValue({ id: 7 }),
    });

    await service.updateLines("org-1", 7, {
      lines: [
        { lineId: 1, countedQty: 10 },
        { lineId: 2, countedQty: 20 },
        { lineId: 3, countedQty: 30 },
      ],
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(cache.invalidate).toHaveBeenCalledTimes(1);
  });
});
