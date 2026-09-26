import { SupportKnowledgeGapStatus } from "../../../db/schema/support/support-kb-gap";
import {
  dismissGapResponseSchema,
  gapListResponseSchema,
} from "./dto/support-kb-gap-response.schemas";
import { dismissGapPatchSchema } from "./dto/support-kb-gap.schemas";

const ROW = {
  id: 1,
  orgId: "org-1",
  clusterKey: "cluster:10",
  representativeQuestion: "How do I get a refund?",
  ticketCount: 4,
  sampleTicketIds: [1, 2],
  status: SupportKnowledgeGapStatus.DISMISSED,
  proposedArticleId: null,
  dismissalReason: "Already answered by the refund policy article",
  draftedBy: null,
  reviewedBy: null,
  evidence: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-02T00:00:00.000Z"),
};

describe("the knowledge-gap response contract", () => {
  it("carries the dismissal reason out to the caller, because a reason the dismisser typed and nobody can read back is a column that does nothing", () => {
    const parsed = dismissGapResponseSchema.parse(ROW);

    expect(parsed).toHaveProperty(
      "dismissalReason",
      "Already answered by the refund policy article",
    );
  });

  it("carries the dismissal reason through the list too, because the gaps page is where a dismissed gap is read, not the dismiss response", () => {
    const parsed = gapListResponseSchema.parse({
      gaps: [{ ...ROW, deflectionCount: 0, proposedArticleTitle: null }],
      nextCursor: null,
    });

    expect(parsed.gaps[0]).toHaveProperty(
      "dismissalReason",
      "Already answered by the refund policy article",
    );
  });

  it("keeps a null dismissal reason as null rather than dropping the key, so the client can tell 'not dismissed' from 'dismissed without a reason'", () => {
    const parsed = dismissGapResponseSchema.parse({
      ...ROW,
      dismissalReason: null,
    });

    expect(Object.keys(parsed)).toContain("dismissalReason");
    expect(parsed.dismissalReason).toBeNull();
  });

  it("withholds the internal cluster key, because it is a clustering identifier no screen renders and exposing it would put a raw internal id on a page", () => {
    const parsed = dismissGapResponseSchema.parse(ROW);

    expect(Object.keys(parsed)).not.toContain("clusterKey");
  });

  it("admits every status the writers can set", () => {
    for (const status of Object.values(SupportKnowledgeGapStatus)) {
      expect(dismissGapResponseSchema.parse({ ...ROW, status }).status).toBe(
        status,
      );
    }
  });

  it("rejects a status outside the five the schema defines, because the frontend contract enumerates exactly those and a sixth would throw on the client instead of here", () => {
    expect(() =>
      dismissGapResponseSchema.parse({ ...ROW, status: "ARCHIVED" }),
    ).toThrow();
  });

  it("rejects an unknown key on the dismiss body, because a misspelt field should 400 rather than be silently dropped", () => {
    expect(() =>
      dismissGapPatchSchema.parse({ action: "dismiss", resaon: "typo" }),
    ).toThrow();
  });
});
