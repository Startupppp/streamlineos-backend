import { assertNever } from "../../../common/types/assert-never";
import {
  decideKbRetrievalStrategy,
  kbAnnEfSearch,
  KB_ANN_EF_SEARCH_MAX,
  KB_ANN_EF_SEARCH_MULTIPLIER,
  KB_EXACT_SCAN_MAX_CHUNKS,
  KB_RETRIEVAL_MIN_RECALL,
  type KbRetrievalStrategy,
} from "./kb-retrieval-strategy";

const CAP = 120;

describe("decideKbRetrievalStrategy — small tenants scan exactly", () => {
  it("chooses exact for an empty tenant", () => {
    expect(decideKbRetrievalStrategy(0, CAP)).toEqual({ kind: "exact" });
  });

  it("chooses exact at the measured minority-tenant size (~780 chunks, 100% recall, p99 11.99 ms)", () => {
    expect(decideKbRetrievalStrategy(780, CAP)).toEqual({ kind: "exact" });
  });

  it("chooses exact exactly AT the threshold, and ann one chunk above it", () => {
    expect(decideKbRetrievalStrategy(KB_EXACT_SCAN_MAX_CHUNKS, CAP)).toEqual({ kind: "exact" });
    expect(decideKbRetrievalStrategy(KB_EXACT_SCAN_MAX_CHUNKS + 1, CAP).kind).toBe("ann");
  });

  it("covers the 8,000-chunk tenant, where forced ANN peaks at 0.7233 but exact is 1.0000", () => {
    expect(decideKbRetrievalStrategy(8_000, CAP)).toEqual({ kind: "exact" });
  });

  it("stops below the 40,000-chunk tenant, where exact costs 647,040 buffers and 387 ms", () => {
    expect(KB_EXACT_SCAN_MAX_CHUNKS).toBeGreaterThanOrEqual(8_000);
    expect(KB_EXACT_SCAN_MAX_CHUNKS).toBeLessThan(40_000);
  });
});

describe("decideKbRetrievalStrategy — large tenants use ANN with a raised ef_search", () => {
  it("chooses ann only above the threshold, where exact stops being affordable", () => {
    expect(decideKbRetrievalStrategy(KB_EXACT_SCAN_MAX_CHUNKS + 1, CAP).kind).toBe("ann");
  });

  it("chooses ann at the measured majority-tenant size (~39,700 chunks)", () => {
    expect(decideKbRetrievalStrategy(39_700, CAP).kind).toBe("ann");
  });

  it("never returns an ef_search below the cap — pgvector cannot return LIMIT good rows below it", () => {
    for (const cap of [1, 4, 24, 96, 120, 125, 400, 999, 1_000]) {
      const strategy = decideKbRetrievalStrategy(50_000, cap);
      expect(strategy.kind).toBe("ann");
      if (strategy.kind !== "ann") continue;
      expect(strategy.efSearch).toBeGreaterThanOrEqual(cap);
      expect(Number.isInteger(strategy.efSearch)).toBe(true);
    }
  });

  it("scales ef_search with the cap rather than pinning one value", () => {
    const small = decideKbRetrievalStrategy(50_000, 24);
    const large = decideKbRetrievalStrategy(50_000, 120);
    expect(small.kind).toBe("ann");
    expect(large.kind).toBe("ann");
    if (small.kind !== "ann" || large.kind !== "ann") return;
    expect(small.efSearch).toBe(24 * KB_ANN_EF_SEARCH_MULTIPLIER);
    expect(large.efSearch).toBe(120 * KB_ANN_EF_SEARCH_MULTIPLIER);
    expect(large.efSearch).toBeGreaterThan(small.efSearch);
  });

  it("clamps ef_search at pgvector's ceiling", () => {
    const strategy = decideKbRetrievalStrategy(50_000, 500);
    expect(strategy.kind).toBe("ann");
    if (strategy.kind !== "ann") return;
    expect(strategy.efSearch).toBe(KB_ANN_EF_SEARCH_MAX);
    expect(kbAnnEfSearch(10_000)).toBe(KB_ANN_EF_SEARCH_MAX);
  });

  it("falls back to exact when the cap exceeds the ceiling, because ANN cannot then meet the floor", () => {
    expect(decideKbRetrievalStrategy(50_000, KB_ANN_EF_SEARCH_MAX)).toEqual({
      kind: "ann",
      efSearch: KB_ANN_EF_SEARCH_MAX,
    });
    expect(decideKbRetrievalStrategy(50_000, KB_ANN_EF_SEARCH_MAX + 1)).toEqual({ kind: "exact" });
  });
});

describe("the recall floor is a stated target, not an implicit hope", () => {
  it("sits above every HNSW cell measured at the pgvector default and below the exact cells", () => {
    expect(KB_RETRIEVAL_MIN_RECALL).toBeGreaterThan(0.4556);
    expect(KB_RETRIEVAL_MIN_RECALL).toBeLessThanOrEqual(1);
  });

  it("the ef_search multiplier is the knob that buys the floor, so it is greater than one", () => {
    expect(KB_ANN_EF_SEARCH_MULTIPLIER).toBeGreaterThan(1);
  });
});

describe("the union is exhaustively handled", () => {
  const describeStrategy = (strategy: KbRetrievalStrategy): string => {
    switch (strategy.kind) {
      case "exact":
        return "exact";
      case "ann":
        return `ann:${strategy.efSearch}`;
      default:
        return assertNever(strategy);
    }
  };

  it("handles both variants without falling through", () => {
    expect(describeStrategy({ kind: "exact" })).toBe("exact");
    expect(describeStrategy({ kind: "ann", efSearch: 960 })).toBe("ann:960");
  });

  it("a variant outside the union reaches assertNever rather than being silently ignored", () => {
    const parseStrategy = (json: string): KbRetrievalStrategy => JSON.parse(json);
    expect(() => describeStrategy(parseStrategy(`{"kind":"planner-choice"}`))).toThrow(
      /Unhandled variant/,
    );
  });
});
