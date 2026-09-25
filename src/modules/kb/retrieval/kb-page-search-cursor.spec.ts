import * as fc from "fast-check";
import {
  decodeSearchCursor,
  encodeSearchCursor,
  searchScopeTag,
} from "./kb-page-search-cursor";
import type { PageFullSearchQuery } from "./dto/kb-page-search-query.schemas";

const FINGERPRINT = "org-1|3|5|0|view|writer|3";

function query(overrides: Partial<PageFullSearchQuery> = {}): Pick<
  PageFullSearchQuery,
  "q" | "spaceId" | "status" | "type" | "verified"
> {
  return { q: "onboarding", ...overrides };
}

describe("KB page search cursor", () => {
  it("round-trips a position so page two resumes exactly where page one stopped", () => {
    const tag = searchScopeTag(query(), FINGERPRINT);
    const cursor = encodeSearchCursor(tag, {
      rank: "0.42",
      updatedAt: "2026-09-23T10:00:00.123456",
      id: 91,
    });

    expect(decodeSearchCursor(cursor, tag)).toEqual({
      rank: "0.42",
      updatedAt: "2026-09-23T10:00:00.123456",
      id: 91,
    });
  });

  it("stays under the 512-byte transport budget", () => {
    const tag = searchScopeTag(query({ q: "x".repeat(200) }), FINGERPRINT);
    const cursor = encodeSearchCursor(tag, {
      rank: "0.999999",
      updatedAt: "2026-09-23T10:00:00.123456",
      id: 2_147_483_647,
    });

    expect(cursor.length).toBeLessThanOrEqual(512);
  });

  it("refuses a cursor minted under a different filter set", () => {
    const original = searchScopeTag(query({ spaceId: 3 }), FINGERPRINT);
    const cursor = encodeSearchCursor(original, {
      rank: "0.4",
      updatedAt: "2026-09-23T10:00:00.123456",
      id: 91,
    });

    const afterFilterChange = searchScopeTag(query(), FINGERPRINT);
    expect(decodeSearchCursor(cursor, afterFilterChange)).toBeNull();
  });

  it("refuses a cursor minted under a different type filter, so switching content type restarts at page one instead of skipping rows", () => {
    const original = searchScopeTag(query({ type: "sop" }), FINGERPRINT);
    const cursor = encodeSearchCursor(original, {
      rank: "0.4",
      updatedAt: "2026-09-23T10:00:00.123456",
      id: 91,
    });

    const afterTypeChange = searchScopeTag(query({ type: "policy" }), FINGERPRINT);
    expect(decodeSearchCursor(cursor, afterTypeChange)).toBeNull();
  });

  it("refuses a cursor minted under a different permission fingerprint", () => {
    const before = searchScopeTag(query(), FINGERPRINT);
    const cursor = encodeSearchCursor(before, {
      rank: "0.4",
      updatedAt: "2026-09-23T10:00:00.123456",
      id: 91,
    });

    const after = searchScopeTag(query(), "org-1|4|5|0|view|writer|3");
    expect(decodeSearchCursor(cursor, after)).toBeNull();
  });

  it("rejects a millisecond timestamp, because a truncated boundary silently drops rows written in the same millisecond", () => {
    const tag = searchScopeTag(query(), FINGERPRINT);
    const cursor = encodeSearchCursor(tag, {
      rank: "0.4",
      updatedAt: "2026-09-23T10:00:00.123Z",
      id: 91,
    });

    expect(decodeSearchCursor(cursor, tag)).toBeNull();
  });

  it("rejects a non-integer id so a hand-edited cursor never reaches the driver", () => {
    const tag = searchScopeTag(query(), FINGERPRINT);
    const forged = Buffer.from(
      [tag, "0.4", "2026-09-23T10:00:00.123456", "1074; --"].join("\u0000"),
      "utf8",
    ).toString("base64url");

    expect(decodeSearchCursor(forged, tag)).toBeNull();
  });

  it("rejects a non-numeric rank so a hand-edited cursor never reaches the driver's ::real cast", () => {
    const tag = searchScopeTag(query(), FINGERPRINT);
    const forged = Buffer.from(
      [tag, "not-a-number", "2026-09-23T10:00:00.123456", "91"].join("\u0000"),
      "utf8",
    ).toString("base64url");

    expect(decodeSearchCursor(forged, tag)).toBeNull();
  });

  it("treats an absent cursor as page one", () => {
    const tag = searchScopeTag(query(), FINGERPRINT);
    expect(decodeSearchCursor(undefined, tag)).toBeNull();
  });
});

describe("KB page search cursor — fuzz", () => {
  const rankArb = fc
    .float({ min: 0, max: 1, noNaN: true })
    .map((n) => n.toString());

  const microsecondTimestamp = fc
    .tuple(
      fc.integer({ min: 2020, max: 2035 }),
      fc.integer({ min: 1, max: 12 }),
      fc.integer({ min: 1, max: 28 }),
      fc.integer({ min: 0, max: 23 }),
      fc.integer({ min: 0, max: 59 }),
      fc.integer({ min: 0, max: 59 }),
      fc.integer({ min: 0, max: 999_999 }),
    )
    .map(([y, mo, d, h, mi, s, micros]) => {
      const pad = (n: number, width: number) => String(n).padStart(width, "0");
      return `${pad(y, 4)}-${pad(mo, 2)}-${pad(d, 2)}T${pad(h, 2)}:${pad(mi, 2)}:${pad(s, 2)}.${pad(micros, 6)}`;
    });

  const idArb = fc.integer({ min: 1, max: 2_147_483_647 });

  it("round-trips every valid (rank, timestamp, id) position", () => {
    fc.assert(
      fc.property(rankArb, microsecondTimestamp, idArb, (rank, updatedAt, id) => {
        const tag = searchScopeTag(query(), FINGERPRINT);
        const cursor = encodeSearchCursor(tag, { rank, updatedAt, id });
        expect(decodeSearchCursor(cursor, tag)).toEqual({ rank, updatedAt, id });
      }),
    );
  });

  it("never accepts a cursor minted under a different scope tag", () => {
    fc.assert(
      fc.property(
        rankArb,
        microsecondTimestamp,
        idArb,
        fc.string(),
        fc.string(),
        (rank, updatedAt, id, fingerprintA, fingerprintB) => {
          fc.pre(fingerprintA !== fingerprintB);
          const tagA = searchScopeTag(query(), fingerprintA);
          const tagB = searchScopeTag(query(), fingerprintB);
          fc.pre(tagA !== tagB);
          const cursor = encodeSearchCursor(tagA, { rank, updatedAt, id });
          expect(decodeSearchCursor(cursor, tagB)).toBeNull();
        },
      ),
    );
  });

  it("never lets an arbitrary byte string decode into a position — either it is null or it round-trips its own re-encoding", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const tag = searchScopeTag(query(), FINGERPRINT);
        const decoded = decodeSearchCursor(raw, tag);
        if (decoded === null) return;
        const reEncoded = encodeSearchCursor(tag, decoded);
        expect(decodeSearchCursor(reEncoded, tag)).toEqual(decoded);
      }),
    );
  });
});
