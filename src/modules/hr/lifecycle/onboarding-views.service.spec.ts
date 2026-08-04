import { ForbiddenException } from "@nestjs/common";
import { OnboardingViewsService } from "./onboarding-views.service";

describe("OnboardingViewsService.list scope gate", () => {
  const orgId = "org-1";
  const actorUserId = "actor-1";

  function createService() {
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            leftJoin: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                orderBy: jest.fn().mockReturnValue({
                  limit: jest.fn().mockReturnValue({
                    offset: jest.fn().mockResolvedValue([]),
                  }),
                }),
              }),
            }),
          }),
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([{ total: 0 }]),
          }),
        }),
      }),
    };
    const automation = { runAutomationsForEvent: jest.fn() };
    return new OnboardingViewsService(db as never, automation as never);
  }

  it("rejects admin cross-user filter when scope is not all", async () => {
    const service = createService();
    await expect(
      service.list(
        orgId,
        actorUserId,
        true,
        { page: 1, limit: 20, userId: "other-user" },
        "team",
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe("OnboardingViewsService.create scope gate", () => {
  it("rejects on-behalf upload when admin scope is not all", async () => {
    const service = new OnboardingViewsService({} as never, { runAutomationsForEvent: jest.fn() } as never);
    await expect(
      service.create(
        "org-1",
        "actor-1",
        true,
        {
          documentTypeId: 1,
          fileUrl: "https://example.com/doc.pdf",
          fileName: "doc.pdf",
          targetUserId: "other-user",
        },
        "team",
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
