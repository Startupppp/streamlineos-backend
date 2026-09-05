import {
  announcementListResponseSchema,
  announcementResponseSchema,
} from "./announcement-response.schema";

const announcement = {
  id: 1,
  orgId: "org-1",
  title: "Service update",
  content: "The service update has been completed.",
  authorId: "user-1",
  targetType: "ALL",
  isPinned: false,
  publishAt: null,
  expiresAt: null,
  status: "PUBLISHED",
  readCount: 0,
  attachmentUrls: [],
  createdAt: new Date("2026-09-05T00:00:00.000Z"),
  updatedAt: new Date("2026-09-05T00:00:00.000Z"),
  targetIds: [],
};

describe("announcement response contracts", () => {
  it("accepts entity and bounded list results", () => {
    expect(announcementResponseSchema.safeParse(announcement).success).toBe(true);
    expect(announcementListResponseSchema.safeParse([announcement]).success).toBe(true);
  });

  it("rejects persistence fields outside the wire contract", () => {
    expect(
      announcementResponseSchema.safeParse({ ...announcement, internalNote: "secret" }).success,
    ).toBe(false);
  });
});
