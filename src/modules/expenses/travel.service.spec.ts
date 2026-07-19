import { BadRequestException, NotFoundException } from "@nestjs/common";
import { TravelService } from "./travel.service";

describe("TravelService — two-stage approval is sequence-enforced", () => {
  function buildDb(existingStatus: string | undefined, updateSucceeds: boolean) {
    return {
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue(updateSucceeds ? [{ id: 1, status: "next" }] : []),
          }),
        }),
      }),
      query: {
        travelRequests: {
          findFirst: jest.fn().mockResolvedValue(existingStatus ? { id: 1, status: existingStatus } : undefined),
        },
      },
    };
  }

  describe("financeApprove", () => {
    it("rejects finance-approving a still-PENDING request (skips manager approval)", async () => {
      const service = new TravelService(buildDb("PENDING", false) as never);
      await expect(service.financeApprove("org-1", 1, "approver-1")).rejects.toBeInstanceOf(BadRequestException);
    });

    it("succeeds when the request is MANAGER_APPROVED", async () => {
      const service = new TravelService(buildDb("MANAGER_APPROVED", true) as never);
      const result = await service.financeApprove("org-1", 1, "approver-1");
      expect(result).toBeDefined();
    });

    it("404s when the request doesn't exist", async () => {
      const service = new TravelService(buildDb(undefined, false) as never);
      await expect(service.financeApprove("org-1", 1, "approver-1")).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("managerApprove", () => {
    it("rejects manager-approving an already MANAGER_APPROVED request", async () => {
      const service = new TravelService(buildDb("MANAGER_APPROVED", false) as never);
      await expect(service.managerApprove("org-1", 1, "approver-1")).rejects.toBeInstanceOf(BadRequestException);
    });

    it("succeeds when the request is PENDING", async () => {
      const service = new TravelService(buildDb("PENDING", true) as never);
      const result = await service.managerApprove("org-1", 1, "approver-1");
      expect(result).toBeDefined();
    });
  });
});
