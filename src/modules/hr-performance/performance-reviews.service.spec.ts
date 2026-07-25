process.env.APP_URL ??= "http://localhost:1000";

import { ConflictException, ForbiddenException } from "@nestjs/common";
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

  function buildOwnershipService(existing: { reviewerId: string; userId: string }) {
    const db = {
      query: {
        performanceReviews: {
          findFirst: jest.fn().mockResolvedValue({ id: 1, orgId: "org-1", status: "IN_PROGRESS", ...existing }),
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
    await expect(service.updateReview("org-1", "actor-1", true, 1,{ ratings: [{ category: "quality", score: 5 }] })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("rejects editing comments on a completed review", async () => {
    const service = buildService("COMPLETED");
    await expect(service.updateReview("org-1", "actor-1", true, 1,{ comments: "changed after completion" })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("rejects reopening a completed review back to IN_PROGRESS", async () => {
    const service = buildService("COMPLETED");
    await expect(service.updateReview("org-1", "actor-1", true, 1,{ status: "IN_PROGRESS" })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("allows archiving a completed review", async () => {
    const service = buildService("COMPLETED");
    const result = await service.updateReview("org-1", "actor-1", true, 1,{ status: "ARCHIVED" });
    expect(result).toEqual({ success: true });
  });

  it("allows editing ratings on a still-IN_PROGRESS review", async () => {
    const service = buildService("IN_PROGRESS");
    const result = await service.updateReview("org-1", "actor-1", true, 1,{ ratings: [{ category: "quality", score: 5 }] });
    expect(result).toEqual({ success: true });
  });

  it("forbids a non-participant, non-manager from editing a review (BOLA)", async () => {
    const service = buildOwnershipService({ reviewerId: "reviewer-1", userId: "subject-1" });
    await expect(
      service.updateReview("org-1", "stranger-1", false, 1, { comments: "not my review" }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("allows the assigned reviewer to edit their review", async () => {
    const service = buildOwnershipService({ reviewerId: "reviewer-1", userId: "subject-1" });
    const result = await service.updateReview("org-1", "reviewer-1", false, 1, { comments: "reviewer note" });
    expect(result).toEqual({ success: true });
  });

  it("allows the review subject to edit their own review", async () => {
    const service = buildOwnershipService({ reviewerId: "reviewer-1", userId: "subject-1" });
    const result = await service.updateReview("org-1", "subject-1", false, 1, { comments: "self-assessment" });
    expect(result).toEqual({ success: true });
  });
});

describe("PerformanceReviewsService.getCycle — bounded, projected reviews", () => {
  function buildCycleService() {
    const findManyMock = jest.fn().mockResolvedValue([{ id: 10, userId: "u1", status: "DRAFT" }]);
    const db = {
      query: {
        reviewCycles: { findFirst: jest.fn().mockResolvedValue({ id: 1, orgId: "org-1", name: "H1" }) },
        performanceReviews: { findMany: findManyMock },
      },
    };
    const service = new PerformanceReviewsService(db as never, undefined as never, undefined as never);
    return { service, findManyMock };
  }

  it("returns the cycle with a bounded (limit 100) reviews array", async () => {
    const { service, findManyMock } = buildCycleService();
    const result = await service.getCycle("org-1", 1);
    expect(result).toMatchObject({ id: 1, name: "H1", reviews: [{ id: 10 }] });
    expect(findManyMock).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
  });
});
