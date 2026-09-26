import {
  KB_PAGE_STATUSES,
  KB_PAGE_TRUST_STATES,
  kbAnalyticsGapActionSchema,
  kbAnalyticsGapRelatedPagesSchema,
  kbAnalyticsPagesSchema,
} from "./dto/kb-helpcenter-response.schemas";
import { SUPPORT_KNOWLEDGE_GAP_STATUSES } from "../../../db/schema/support/support-kb-gap";
import { SupportKnowledgeGapStatus } from "../../../db/schema/support/support-kb-gap";

const PAGE_ROW = {
  id: 1,
  title: "Refund policy",
  status: "draft",
  trustState: "unverified",
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  uniqueViewers: 3,
  commentCount: 0,
  versionCount: 2,
};

const page = (row: Record<string, unknown>) => ({
  data: [row],
  pagination: { limit: 20, hasMore: false, nextCursor: null },
});

describe("the analytics list speaks the page vocabulary, not free text", () => {
  it("admits every status kb_pages.status is typed to hold", () => {
    for (const status of KB_PAGE_STATUSES) {
      expect(() =>
        kbAnalyticsPagesSchema.parse(page({ ...PAGE_ROW, status })),
      ).not.toThrow();
    }
  });

  it("admits every trust state kb_pages.trust_state is typed to hold", () => {
    for (const trustState of KB_PAGE_TRUST_STATES) {
      expect(() =>
        kbAnalyticsPagesSchema.parse(page({ ...PAGE_ROW, trustState })),
      ).not.toThrow();
    }
  });

  it("rejects a status outside that set, because the frontend row type enumerates exactly these and a free string there was a type error the whole way up", () => {
    expect(() =>
      kbAnalyticsPagesSchema.parse(page({ ...PAGE_ROW, status: "retired" })),
    ).toThrow();
  });

  it("rejects a trust state outside that set", () => {
    expect(() =>
      kbAnalyticsPagesSchema.parse(
        page({ ...PAGE_ROW, trustState: "probably_fine" }),
      ),
    ).toThrow();
  });

  it("uses the same page vocabulary on the gap-related-pages list, so one analytics response cannot disagree with another about what a status is", () => {
    const related = {
      data: [
        {
          id: 1,
          title: "Refund policy",
          status: "published",
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      ],
      pagination: { limit: 20, hasMore: false, nextCursor: null },
    };

    expect(() => kbAnalyticsGapRelatedPagesSchema.parse(related)).not.toThrow();
    expect(() =>
      kbAnalyticsGapRelatedPagesSchema.parse({
        ...related,
        data: [{ ...related.data[0], status: "retired" }],
      }),
    ).toThrow();
  });

  it("speaks the knowledge-gap vocabulary on the gap action, not the page one, because those are different columns on different tables", () => {
    const action = {
      id: 1,
      clusterKey: "cluster:10",
      status: SupportKnowledgeGapStatus.DISMISSED,
      proposedArticleId: null,
      draftedBy: null,
      dismissalReason: "Already covered by the refund policy article",
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };

    expect(() => kbAnalyticsGapActionSchema.parse(action)).not.toThrow();
    expect(() =>
      kbAnalyticsGapActionSchema.parse({ ...action, status: "published" }),
    ).toThrow();
    expect(SUPPORT_KNOWLEDGE_GAP_STATUSES).not.toContain("published");
  });
});
