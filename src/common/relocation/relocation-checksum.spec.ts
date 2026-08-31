import {
  assertChecksumMatch,
  compareChecksums,
  objectStorageDigestKey,
  partitionDigestSql,
  tableDigestSql,
  type ChecksumEntry,
} from "./relocation-checksum";
import {
  assertTransitionAllowed,
  RelocationTransitionError,
} from "./relocation-state";

function entry(
  scope: ChecksumEntry["scope"],
  name: string,
  digest: string,
): ChecksumEntry {
  return { scope, name, digest };
}

describe("compareChecksums — matching sets", () => {
  it("returns match=true when source and target are identical", () => {
    const source: ChecksumEntry[] = [
      entry("table", "public.tickets", "abc123"),
      entry("object", "org/org-1/doc.pdf", "def456"),
    ];
    const target: ChecksumEntry[] = [
      entry("table", "public.tickets", "abc123"),
      entry("object", "org/org-1/doc.pdf", "def456"),
    ];
    const result = compareChecksums(source, target);
    expect(result.match).toBe(true);
  });

  it("returns match=true for an empty set", () => {
    expect(compareChecksums([], []).match).toBe(true);
  });
});

describe("compareChecksums — mismatches", () => {
  it("reports a mismatch when digests differ for the same scope+name", () => {
    const source: ChecksumEntry[] = [entry("table", "public.tickets", "abc")];
    const target: ChecksumEntry[] = [entry("table", "public.tickets", "xyz")];
    const result = compareChecksums(source, target);
    expect(result.match).toBe(false);
    if (result.match) throw new Error("unreachable");
    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0]?.name).toBe("public.tickets");
    expect(result.mismatches[0]?.sourceDigest).toBe("abc");
    expect(result.mismatches[0]?.targetDigest).toBe("xyz");
  });

  it("reports a missing target entry as a mismatch", () => {
    const source: ChecksumEntry[] = [entry("table", "public.tickets", "abc")];
    const result = compareChecksums(source, []);
    expect(result.match).toBe(false);
    if (result.match) throw new Error("unreachable");
    expect(result.mismatches[0]?.targetDigest).toBe("<missing>");
  });

  it("reports a missing source entry as a mismatch", () => {
    const target: ChecksumEntry[] = [entry("table", "public.tickets", "abc")];
    const result = compareChecksums([], target);
    expect(result.match).toBe(false);
    if (result.match) throw new Error("unreachable");
    expect(result.mismatches[0]?.sourceDigest).toBe("<missing>");
  });

  it("distinguishes scope so table:foo and object:foo are different keys", () => {
    const source: ChecksumEntry[] = [entry("table", "foo", "abc")];
    const target: ChecksumEntry[] = [entry("object", "foo", "abc")];
    const result = compareChecksums(source, target);
    expect(result.match).toBe(false);
    if (result.match) throw new Error("unreachable");
    expect(result.mismatches).toHaveLength(2);
  });
});

describe("assertChecksumMatch", () => {
  it("does not throw when the comparison matches", () => {
    const source: ChecksumEntry[] = [entry("table", "public.tickets", "abc")];
    const comparison = compareChecksums(source, source);
    expect(() => assertChecksumMatch(comparison, "VERIFY_TARGET")).not.toThrow();
  });

  it("throws when there is a mismatch — the only legal next state is FAILED", () => {
    const source: ChecksumEntry[] = [entry("table", "public.tickets", "abc")];
    const target: ChecksumEntry[] = [entry("table", "public.tickets", "xyz")];
    const comparison = compareChecksums(source, target);
    expect(() => assertChecksumMatch(comparison, "VERIFY_TARGET")).toThrow();
  });

  it("after a mismatch, assertTransitionAllowed permits VERIFY_TARGET->FAILED", () => {
    expect(() => assertTransitionAllowed("VERIFY_TARGET", "FAILED")).not.toThrow();
  });

  it("after a mismatch, assertTransitionAllowed rejects VERIFY_TARGET->FLIP_PLACEMENT", () => {
    const source: ChecksumEntry[] = [entry("table", "public.tickets", "abc")];
    const target: ChecksumEntry[] = [entry("table", "public.tickets", "xyz")];
    const comparison = compareChecksums(source, target);

    expect(comparison.match).toBe(false);
    expect(() =>
      assertTransitionAllowed("VERIFY_TARGET", "FLIP_PLACEMENT"),
    ).not.toThrow();

    expect(() =>
      assertChecksumMatch(comparison, "VERIFY_TARGET"),
    ).toThrow();

    expect(() =>
      assertTransitionAllowed("VERIFY_TARGET", "ACTIVE_SOURCE"),
    ).toThrow(RelocationTransitionError);
  });
});

describe("tableDigestSql", () => {
  it("generates deterministic SQL using md5 and string_agg ordered by the given columns", () => {
    const sql = tableDigestSql("public", "tickets", "org_id", "org-1", ["id", "updated_at"]);
    expect(sql).toContain("md5(string_agg(");
    expect(sql).toContain('"public"."tickets"');
    expect(sql).toContain("org_id");
    expect(sql).toContain("org-1");
    expect(sql).toContain('"id"');
    expect(sql).toContain('"updated_at"');
    expect(sql).toContain("AS digest");
  });

  it("qualifies the table with double-quoted schema and table name to handle reserved words", () => {
    const sql = tableDigestSql("build", "order", "org_id", "org-x", ["id"]);
    expect(sql).toContain('"build"."order"');
  });
});

describe("partitionDigestSql", () => {
  it("produces the same shape as tableDigestSql for a named partition", () => {
    const sql = partitionDigestSql(
      "public",
      "outbox_events_2026_01",
      "organization_id",
      "org-1",
      ["outbox_event_id"],
    );
    expect(sql).toContain('"public"."outbox_events_2026_01"');
    expect(sql).toContain("organization_id");
  });
});

describe("objectStorageDigestKey", () => {
  it("substitutes {orgId} in the prefix", () => {
    const key = objectStorageDigestKey("org/{orgId}/documents/", "abc-123");
    expect(key).toBe("org/abc-123/documents/");
  });
});
