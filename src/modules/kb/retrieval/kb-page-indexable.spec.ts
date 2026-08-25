import { isPageIndexable } from "./kb-indexing.service";

type PageLike = { status: string; deletedAt: Date | null };

function make(overrides: Partial<PageLike> = {}): PageLike {
  return { status: "published", deletedAt: null, ...overrides };
}

describe("isPageIndexable", () => {
  it("returns true for a published non-deleted page", () => {
    expect(isPageIndexable(make())).toBe(true);
  });

  it("returns true for a draft page (draft is the working state)", () => {
    expect(isPageIndexable(make({ status: "draft" }))).toBe(true);
  });

  it("returns true for an in_review page", () => {
    expect(isPageIndexable(make({ status: "in_review" }))).toBe(true);
  });

  it("returns false for an archived page", () => {
    expect(isPageIndexable(make({ status: "archived" }))).toBe(false);
  });

  it("returns false for a soft-deleted page", () => {
    expect(isPageIndexable(make({ deletedAt: new Date() }))).toBe(false);
  });

  it("returns false for a deleted page regardless of status", () => {
    expect(isPageIndexable(make({ status: "published", deletedAt: new Date() }))).toBe(false);
  });
});
