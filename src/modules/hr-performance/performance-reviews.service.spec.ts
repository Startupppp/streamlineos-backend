process.env.APP_URL ??= "http://localhost:1000";

import { ConflictException } from "@nestjs/common";
import { PerformanceReviewsService } from "./performance-reviews.service";

describe("PerformanceReviewsService.updateReview — completed reviews are actually immutable", () => {
  function buildService(existingStatus: string) {
    const db = {
      query: {
        performanceReviews: {
          findFirst: jest.fn().mockResolvedValue({ id: 1, orgId: "org-1", status: existingStatus }),
        },
      },
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(undefined),
        }),
      }),
    };
    return new PerformanceReviewsService(db as never, undefined as never, undefined as never);
  }

  it("rejects editing ratings on a completed review", async () => {
    const service = buildService("COMPLETED");
    await expect(service.updateReview("org-1", 1, { ratings: [{ category: "quality", score: 5 }] })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("rejects editing comments on a completed review", async () => {
    const service = buildService("COMPLETED");
    await expect(service.updateReview("org-1", 1, { comments: "changed after completion" })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("rejects reopening a completed review back to IN_PROGRESS", async () => {
    const service = buildService("COMPLETED");
    await expect(service.updateReview("org-1", 1, { status: "IN_PROGRESS" })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("allows archiving a completed review", async () => {
    const service = buildService("COMPLETED");
    const result = await service.updateReview("org-1", 1, { status: "ARCHIVED" });
    expect(result).toEqual({ success: true });
  });

  it("allows editing ratings on a still-IN_PROGRESS review", async () => {
    const service = buildService("IN_PROGRESS");
    const result = await service.updateReview("org-1", 1, { ratings: [{ category: "quality", score: 5 }] });
    expect(result).toEqual({ success: true });
  });
});
