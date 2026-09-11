import { BadRequestException } from "@nestjs/common";
import { AssetsService } from "./assets.service";

describe("AssetsService.updateAssetReturn — terminal status guard", () => {
  function buildDb(existingStatus: string) {
    return {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([{ id: 1, orgId: "org-1", status: existingStatus }]),
          }),
        }),
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([{ id: 1, status: "RETURNED" }]),
          }),
        }),
      }),
    };
  }

  it.each(["RETURNED", "DAMAGED", "LOST"])(
    "rejects re-patching a return record already finalized as %s",
    async (finalStatus) => {
      const service = new AssetsService(buildDb(finalStatus) as never);
      await expect(
        service.updateAssetReturn("org-1", 1, { status: "RETURNED" }),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it("allows finalizing a still-PENDING return", async () => {
    const service = new AssetsService(buildDb("PENDING") as never);
    const result = await service.updateAssetReturn("org-1", 1, { status: "DAMAGED" });
    expect(result).toBeDefined();
  });
});
