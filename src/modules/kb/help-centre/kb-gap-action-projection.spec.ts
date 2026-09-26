import { readFileSync } from "node:fs";
import { join } from "node:path";
import { kbAnalyticsGapActionSchema } from "./dto/kb-helpcenter-response.schemas";

const SERVICE = readFileSync(
  join(__dirname, "kb-analytics.service.ts"),
  "utf8",
);

function gapReturningBlocks(source: string): string[] {
  const blocks: string[] = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf(".returning({", from);
    if (start === -1) break;
    const end = source.indexOf("});", start);
    if (end === -1) break;
    const block = source.slice(start, end);
    if (block.includes("supportKnowledgeGaps.clusterKey")) blocks.push(block);
    from = end + 1;
  }
  return blocks;
}

describe("the knowledge-gap action routes and what they project", () => {
  it("finds every gap projection, so a scan that matched nothing cannot pass vacuously", () => {
    expect(gapReturningBlocks(SERVICE).length).toBeGreaterThanOrEqual(3);
  });

  it("projects dismissalReason from all three, because assign, dismiss and create-fix share one response schema and a caller cannot know which handler answered", () => {
    const missing = gapReturningBlocks(SERVICE).filter(
      (block) => !block.includes("supportKnowledgeGaps.dismissalReason"),
    );

    expect(missing).toEqual([]);
  });

  it("requires dismissalReason on the shared schema rather than making it optional, so a projection that drops it fails instead of going quiet", () => {
    const withoutReason = {
      id: 1,
      clusterKey: "cluster:10",
      status: "DISMISSED",
      proposedArticleId: null,
      draftedBy: null,
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };

    expect(() => kbAnalyticsGapActionSchema.parse(withoutReason)).toThrow();
    expect(() =>
      kbAnalyticsGapActionSchema.parse({ ...withoutReason, dismissalReason: null }),
    ).not.toThrow();
  });
});
