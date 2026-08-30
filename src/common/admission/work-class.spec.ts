import {
  isReserved,
  shedRank,
  NUM_SHEDDABLE_RANKS,
  type SheddableClass,
  type ReservedClass,
  type WorkClass,
} from "./work-class";

const SHEDDABLE_CLASSES: SheddableClass[] = [
  "prefetch",
  "analytics-refresh",
  "ai-enrichment",
  "search-freshness",
  "non-mandatory-notification",
  "ordinary-write",
];

const RESERVED_CLASSES: ReservedClass[] = [
  "authentication",
  "authorization-revocation",
  "ownership",
  "billing-ledger",
  "payroll-posting",
  "audit",
  "mandatory-security-delivery",
];

const ALL_CLASSES: WorkClass[] = [...SHEDDABLE_CLASSES, ...RESERVED_CLASSES];

describe("isReserved", () => {
  it("returns false for every sheddable class", () => {
    for (const wc of SHEDDABLE_CLASSES)
      expect(isReserved(wc)).toBe(false);
  });

  it("returns true for every reserved class", () => {
    for (const wc of RESERVED_CLASSES)
      expect(isReserved(wc)).toBe(true);
  });

  it("covers every WorkClass without a default branch — exhaustiveness is enforced by TypeScript", () => {
    expect(ALL_CLASSES.every((wc) => typeof isReserved(wc) === "boolean")).toBe(true);
  });
});

describe("shedRank", () => {
  it("assigns a unique integer rank to every sheddable class", () => {
    const ranks = SHEDDABLE_CLASSES.map(shedRank);
    const unique = new Set(ranks);
    expect(unique.size).toBe(SHEDDABLE_CLASSES.length);
  });

  it("ranks are in the range [0, NUM_SHEDDABLE_RANKS)", () => {
    for (const wc of SHEDDABLE_CLASSES) {
      const r = shedRank(wc);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(NUM_SHEDDABLE_RANKS);
    }
  });

  it("NUM_SHEDDABLE_RANKS equals the number of sheddable classes", () => {
    expect(NUM_SHEDDABLE_RANKS).toBe(SHEDDABLE_CLASSES.length);
  });

  it("shed order: prefetch < analytics-refresh < ai-enrichment < search-freshness < non-mandatory-notification < ordinary-write", () => {
    expect(shedRank("prefetch")).toBeLessThan(shedRank("analytics-refresh"));
    expect(shedRank("analytics-refresh")).toBeLessThan(shedRank("ai-enrichment"));
    expect(shedRank("ai-enrichment")).toBeLessThan(shedRank("search-freshness"));
    expect(shedRank("search-freshness")).toBeLessThan(shedRank("non-mandatory-notification"));
    expect(shedRank("non-mandatory-notification")).toBeLessThan(shedRank("ordinary-write"));
  });

  it("prefetch has the lowest rank — it is the first to be refused", () => {
    const lowestRank = Math.min(...SHEDDABLE_CLASSES.map(shedRank));
    expect(shedRank("prefetch")).toBe(lowestRank);
  });

  it("ordinary-write has the highest rank — sheddable capacity is exhausted before it is refused", () => {
    const highestRank = Math.max(...SHEDDABLE_CLASSES.map(shedRank));
    expect(shedRank("ordinary-write")).toBe(highestRank);
  });
});

describe("replica-routing concern: analytics-refresh and search-freshness are the only replica-safe sheddable classes", () => {
  it("those two classes are sheddable (not reserved), which is the prerequisite for replica routing", () => {
    expect(isReserved("analytics-refresh")).toBe(false);
    expect(isReserved("search-freshness")).toBe(false);
  });

  it("reserved classes are primary-required by definition — replica routing never touches them", () => {
    for (const wc of RESERVED_CLASSES)
      expect(isReserved(wc)).toBe(true);
  });
});
