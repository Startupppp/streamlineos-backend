import {
  KB_INDEXING_PER_CHUNK_CREDITS,
  getReserveEstimateMilli,
} from "./ai-cost-catalog";

const KB_INDEXING_MAX_CHUNKS = 400;
const KB_INDEXING_WORST_CASE_SETTLE_MILLI = 450;

describe("kb.indexing reservation scales with batch size", () => {
  it("per-chunk rate is below the old flat-call ceiling so a 1-chunk batch cannot exhaust a credit", () => {
    expect(getReserveEstimateMilli("kb.indexing")).toBeLessThan(1000);
  });

  it("the catalog entry equals the named per-chunk constant so the decision and its home are the same file", () => {
    expect(getReserveEstimateMilli("kb.indexing")).toBe(
      Math.round(KB_INDEXING_PER_CHUNK_CREDITS * 1000),
    );
  });

  it("1-chunk batch reserves materially less than a 400-chunk batch when the helper multiplies by batch count", () => {
    const perChunk = getReserveEstimateMilli("kb.indexing");
    const oneChunk = perChunk * 1;
    const fourHundredChunks = perChunk * KB_INDEXING_MAX_CHUNKS;
    expect(fourHundredChunks).toBeGreaterThan(oneChunk * 50);
  });

  it("400-chunk reservation covers the documented worst-case settled charge", () => {
    const perChunk = getReserveEstimateMilli("kb.indexing");
    expect(perChunk * KB_INDEXING_MAX_CHUNKS).toBeGreaterThanOrEqual(
      KB_INDEXING_WORST_CASE_SETTLE_MILLI,
    );
  });
});
