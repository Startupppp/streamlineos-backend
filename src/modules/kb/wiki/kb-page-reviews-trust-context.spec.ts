import { kbPageReviewWithContextSchema } from "./dto/kb-wiki-response.schemas";

describe("a reviewer is shown the page's trust state alongside the review", () => {
  const base = {
    id: 1,
    orgId: "org-1",
    pageId: 7,
    pageTitle: "Runbook",
    type: "approval",
    status: "pending",
    isOverdue: false,
    requestedById: null,
    reviewerId: null,
    requestedByMembershipId: null,
    reviewerMembershipId: null,
    requestedByName: null,
    reviewerName: null,
    dueAt: null,
    decidedAt: null,
    decisionNote: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };

  it("declares pageTrustState, because deciding a review without knowing the page is stale is the defect", () => {
    const parsed = kbPageReviewWithContextSchema.safeParse({
      ...base,
      pageTrustState: "verification_expired",
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.pageTrustState).toBe(
      "verification_expired",
    );
  });

  it("accepts every trust state the page column can hold, so the contract cannot narrow it", () => {
    for (const state of ["unverified", "verified", "verification_expired"]) {
      expect(
        kbPageReviewWithContextSchema.safeParse({ ...base, pageTrustState: state })
          .success,
      ).toBe(true);
    }
  });

  it("allows a null trust state, because the page join is a left join and may miss", () => {
    expect(
      kbPageReviewWithContextSchema.safeParse({ ...base, pageTrustState: null })
        .success,
    ).toBe(true);
  });

  it("rejects a trust state outside the page enum, so the field is not a bare string", () => {
    expect(
      kbPageReviewWithContextSchema.safeParse({
        ...base,
        pageTrustState: "probably_fine",
      }).success,
    ).toBe(false);
  });

  it("still rejects a payload missing pageTitle, so the assertions above are not passing vacuously", () => {
    const { pageTitle: _omitted, ...withoutTitle } = base;

    expect(
      kbPageReviewWithContextSchema.safeParse({
        ...withoutTitle,
        pageTrustState: "verified",
      }).success,
    ).toBe(false);
  });
});
