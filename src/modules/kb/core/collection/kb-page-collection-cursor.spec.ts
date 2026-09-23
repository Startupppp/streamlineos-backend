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
