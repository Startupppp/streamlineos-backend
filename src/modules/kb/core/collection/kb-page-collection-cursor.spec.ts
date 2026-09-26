import * as fc from "fast-check";
import {
  collectionScopeTag,
  decodeCollectionCursor,
  encodeCollectionCursor,
} from "./kb-page-collection-cursor";
import type { KbPageCollectionQuery } from "./knowledge-collection.types";

const FINGERPRINT = "org-1|7|42|0|view|writer|1.2|3";

function query(
  overrides: Partial<KbPageCollectionQuery> = {},
): KbPageCollectionQuery {
  return { sort: "updated_desc", limit: 50, ...overrides };
}

describe("KB collection cursor", () => {
  it("round-trips a position so page two resumes exactly where page one stopped", () => {
    const tag = collectionScopeTag(query(), FINGERPRINT);
    const cursor = encodeCollectionCursor(tag, {
      sortValue: "2026-09-23T10:00:00.123456",
      id: 91,
    });

    expect(decodeCollectionCursor(cursor, tag, "updated_desc")).toEqual({
      sortValue: "2026-09-23T10:00:00.123456",
      id: 91,
    });
  });

  it("stays under the 512-byte transport budget", () => {
    const tag = collectionScopeTag(query({ q: "x".repeat(200) }), FINGERPRINT);
    const cursor = encodeCollectionCursor(tag, {
      sortValue: "z".repeat(200),
      id: 2_147_483_647,
    });

    expect(cursor.length).toBeLessThanOrEqual(512);
  });

  it("refuses a cursor minted under a different filter set, so a changed filter restarts at page one instead of skipping rows", () => {
    const original = collectionScopeTag(query({ owner: "me" }), FINGERPRINT);
    const cursor = encodeCollectionCursor(original, {
      sortValue: "2026-09-23T10:00:00.123456",
      id: 91,
    });

    const afterFilterChange = collectionScopeTag(query(), FINGERPRINT);

    expect(decodeCollectionCursor(cursor, original, "updated_desc")).not.toBeNull();
    expect(
      decodeCollectionCursor(cursor, afterFilterChange, "updated_desc"),
    ).toBeNull();
  });

  it("refuses a cursor minted under a different permission fingerprint, so an access change cannot page through a stale window", () => {
    const before = collectionScopeTag(query(), FINGERPRINT);
    const cursor = encodeCollectionCursor(before, {
      sortValue: "2026-09-23T10:00:00.123456",
      id: 91,
    });

    const afterRevocation = collectionScopeTag(
      query(),
      "org-1|8|42|0|view|writer|1|3",
    );

    expect(decodeCollectionCursor(cursor, afterRevocation, "updated_desc")).toBeNull();
  });

  it("refuses a cursor minted for one sort when replayed against another", () => {
    const tag = collectionScopeTag(query({ sort: "title_asc" }), FINGERPRINT);
    const cursor = encodeCollectionCursor(tag, {
      sortValue: "Onboarding",
      id: 91,
    });

    expect(decodeCollectionCursor(cursor, tag, "title_asc")).not.toBeNull();
    expect(decodeCollectionCursor(cursor, tag, "updated_desc")).toBeNull();
  });

  it("carries an empty title without becoming undecodable, because kb_pages.title defaults to the empty string", () => {
    const tag = collectionScopeTag(query({ sort: "title_asc" }), FINGERPRINT);
    const cursor = encodeCollectionCursor(tag, { sortValue: "", id: 7 });

    expect(decodeCollectionCursor(cursor, tag, "title_asc")).toEqual({
      sortValue: "",
      id: 7,
    });
  });

  it("rejects rather than mis-splits a sort value holding the tuple separator, which PostgreSQL text cannot contain so no real page reaches it", () => {
    const tag = collectionScopeTag(query({ sort: "title_asc" }), FINGERPRINT);
    const awkward = "Q3 \u0000 plan";
    const cursor = encodeCollectionCursor(tag, { sortValue: awkward, id: 7 });

    expect(decodeCollectionCursor(cursor, tag, "title_asc")).toBeNull();
  });

  it("answers a malformed or hand-edited cursor with page one rather than an error", () => {
    const tag = collectionScopeTag(query(), FINGERPRINT);

    for (const bad of [
      "not-base64url!!",
      Buffer.from("only-one-part", "utf8").toString("base64url"),
      encodeCollectionCursor(tag, {
        sortValue: "2026-09-23T10:00:00.123456",
        id: 91,
      }).slice(0, 6),
    ]) {
      expect(decodeCollectionCursor(bad, tag, "updated_desc")).toBeNull();
    }
  });

  it("rejects a non-integer id so a hand-edited cursor never reaches the driver", () => {
    const tag = collectionScopeTag(query(), FINGERPRINT);
    const forged = Buffer.from(
      [tag, "v2026-09-23T10:00:00.123456", "1074; --"].join("\u0000"),
      "utf8",
    ).toString("base64url");

    expect(decodeCollectionCursor(forged, tag, "updated_desc")).toBeNull();
  });

  it("rejects a millisecond timestamp on a timestamp sort, because a truncated boundary silently drops rows written in the same millisecond", () => {
    const tag = collectionScopeTag(query(), FINGERPRINT);
    const truncated = encodeCollectionCursor(tag, {
      sortValue: "2026-09-23T10:00:00.123Z",
      id: 91,
    });

    expect(decodeCollectionCursor(truncated, tag, "updated_desc")).toBeNull();
  });

  it("treats an absent cursor as page one", () => {
    const tag = collectionScopeTag(query(), FINGERPRINT);
    expect(decodeCollectionCursor(undefined, tag, "updated_desc")).toBeNull();
  });
});

describe("KB collection cursor — fuzz", () => {
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

  const titleSortValue = fc
    .string({ maxLength: 300 })
    .filter((s) => !s.includes("\u0000"));

  const idArb = fc.integer({ min: 1, max: 2_147_483_647 });

  it("round-trips every microsecond-timestamp position for a timestamp sort", () => {
    fc.assert(
      fc.property(microsecondTimestamp, idArb, (sortValue, id) => {
        const tag = collectionScopeTag(query(), FINGERPRINT);
        const cursor = encodeCollectionCursor(tag, { sortValue, id });
        expect(decodeCollectionCursor(cursor, tag, "updated_desc")).toEqual({
          sortValue,
          id,
        });
      }),
    );
  });

  it("round-trips every non-nul title position for a title sort", () => {
    fc.assert(
      fc.property(titleSortValue, idArb, (sortValue, id) => {
        const tag = collectionScopeTag(query({ sort: "title_asc" }), FINGERPRINT);
        const cursor = encodeCollectionCursor(tag, { sortValue, id });
        expect(decodeCollectionCursor(cursor, tag, "title_asc")).toEqual({
          sortValue,
          id,
        });
      }),
    );
  });

  it("never exceeds the 512-byte transport budget for any title up to the schema's own cap", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 200 }).filter((s) => !s.includes("\u0000")),
        idArb,
        (sortValue, id) => {
          const tag = collectionScopeTag(query({ sort: "title_asc" }), FINGERPRINT);
          const cursor = encodeCollectionCursor(tag, { sortValue, id });
          expect(cursor.length).toBeLessThanOrEqual(512);
        },
      ),
    );
  });

  it("never accepts a cursor minted under a different scope tag, for any filter/fingerprint pair", () => {
    fc.assert(
      fc.property(
        microsecondTimestamp,
        idArb,
        fc.string(),
        fc.string(),
        (sortValue, id, fingerprintA, fingerprintB) => {
          fc.pre(fingerprintA !== fingerprintB);
          const tagA = collectionScopeTag(query(), fingerprintA);
          const tagB = collectionScopeTag(query(), fingerprintB);
          fc.pre(tagA !== tagB);
          const cursor = encodeCollectionCursor(tagA, { sortValue, id });
          expect(decodeCollectionCursor(cursor, tagB, "updated_desc")).toBeNull();
        },
      ),
    );
  });

  it("never lets an arbitrary byte string decode into a position — either it is null or it round-trips its own re-encoding", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const tag = collectionScopeTag(query(), FINGERPRINT);
        const decoded = decodeCollectionCursor(raw, tag, "updated_desc");
        if (decoded === null) return;
        const reEncoded = encodeCollectionCursor(tag, decoded);
        expect(decodeCollectionCursor(reEncoded, tag, "updated_desc")).toEqual(
          decoded,
        );
      }),
    );
  });
});
