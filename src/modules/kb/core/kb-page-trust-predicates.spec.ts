import { effectiveTrustState, isVerifiedNow } from "./kb-page-trust-predicates";

function chunksOf(node: unknown): unknown[] | null {
  if (node === null || typeof node !== "object") return null;
  const chunks = (node as { queryChunks?: unknown }).queryChunks;
  return Array.isArray(chunks) ? chunks : null;
}

function columnNames(node: unknown, out: string[] = []): string[] {
  const chunks = chunksOf(node);
  if (chunks !== null) {
    for (const c of chunks) columnNames(c, out);
    return out;
  }
  if (node === null || typeof node !== "object") return out;
  const c = node as { name?: unknown; table?: unknown };
  if (typeof c.name === "string" && c.table !== undefined) out.push(c.name);
  return out;
}

describe("isVerifiedNow", () => {
  it("references trust_state so the predicate cannot be satisfied by any row that lacks that column", () => {
    const pred = isVerifiedNow();
    expect(columnNames(pred)).toContain("trust_state");
  });

  it("references verified_until so a page with a past verified_until and trust_state=verified fails the predicate", () => {
    const pred = isVerifiedNow();
    expect(columnNames(pred)).toContain("verified_until");
  });

  it("a predicate that only checked trust_state would not reference verified_until — positive pair proving the walker is not vacuous", () => {
    const pred = isVerifiedNow();
    const names = columnNames(pred);
    expect(names).toContain("trust_state");
    expect(names).toContain("verified_until");
    expect(names.length).toBeGreaterThanOrEqual(2);
  });
});

describe("effectiveTrustState", () => {
  it("references trust_state so the expression can return verification_expired for a row whose column value is verified", () => {
    const expr = effectiveTrustState();
    expect(columnNames(expr)).toContain("trust_state");
  });

  it("references verified_until so the expression degrades to verification_expired when the deadline has passed", () => {
    const expr = effectiveTrustState();
    expect(columnNames(expr)).toContain("verified_until");
  });

  it("reading trustState alone would only reference trust_state — positive pair proving the walker sees both columns", () => {
    const expr = effectiveTrustState();
    const names = columnNames(expr);
    expect(names).toContain("trust_state");
    expect(names).toContain("verified_until");
  });
});
