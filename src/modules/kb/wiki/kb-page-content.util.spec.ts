import { extractMentionUserIds, extractPageLinkIds } from "./kb-page-content.util";

const makeDoc = (nodes: unknown[]): unknown => ({ type: "doc", content: nodes });

const pageLink = (pageId: number): unknown => ({ type: "pageLink", attrs: { pageId } });

const mention = (id: string): unknown => ({ type: "mention", attrs: { id } });

const paragraph = (children: unknown[]): unknown => ({ type: "paragraph", content: children });

const slatePageLink = (pageId: number): unknown => ({ type: "page_link", pageId, value: "Page Name", children: [{ text: "" }] });

const slateMention = (userId: string): unknown => ({ type: "mention", key: userId, value: "John", children: [{ text: "" }] });
const slateMentionLegacy = (userId: string): unknown => ({ type: "mention", userId, value: "John", children: [{ text: "" }] });

const slateParagraph = (children: unknown[]): unknown => ({ type: "paragraph", children });

describe("extractPageLinkIds", () => {
  it("returns empty array for null/undefined input", () => {
    expect(extractPageLinkIds(null)).toEqual([]);
    expect(extractPageLinkIds(undefined)).toEqual([]);
  });

  it("returns empty array for non-object input", () => {
    expect(extractPageLinkIds("string")).toEqual([]);
    expect(extractPageLinkIds(42)).toEqual([]);
  });

  it("returns empty array for a document with no page links", () => {
    expect(extractPageLinkIds(makeDoc([paragraph([{ type: "text", text: "Hello" }])]))).toEqual([]);
  });

  it("extracts top-level page link ids", () => {
    const doc = makeDoc([pageLink(1), pageLink(2)]);
    expect(extractPageLinkIds(doc)).toEqual([1, 2]);
  });

  it("extracts nested page link ids", () => {
    const doc = makeDoc([paragraph([pageLink(5)])]);
    expect(extractPageLinkIds(doc)).toEqual([5]);
  });

  it("deduplicates repeated page link ids", () => {
    const doc = makeDoc([pageLink(3), pageLink(3), pageLink(4)]);
    expect(extractPageLinkIds(doc)).toEqual([3, 4]);
  });

  it("ignores nodes without numeric pageId attr", () => {
    const doc = makeDoc([{ type: "pageLink", attrs: { pageId: "not-a-number" } }]);
    expect(extractPageLinkIds(doc)).toEqual([]);
  });

  it("does not throw on garbage input", () => {
    expect(() => extractPageLinkIds({ type: "doc", content: [{ type: "pageLink", attrs: null }] })).not.toThrow();
  });
});

describe("extractMentionUserIds", () => {
  it("returns empty array for null/undefined input", () => {
    expect(extractMentionUserIds(null)).toEqual([]);
    expect(extractMentionUserIds(undefined)).toEqual([]);
  });

  it("returns empty array for a document with no mentions", () => {
    expect(extractMentionUserIds(makeDoc([paragraph([{ type: "text", text: "Hello" }])]))).toEqual([]);
  });

  it("extracts mention user ids", () => {
    const doc = makeDoc([mention("user-1"), mention("user-2")]);
    expect(extractMentionUserIds(doc)).toEqual(["user-1", "user-2"]);
  });

  it("extracts nested mention user ids", () => {
    const doc = makeDoc([paragraph([mention("user-3")])]);
    expect(extractMentionUserIds(doc)).toEqual(["user-3"]);
  });

  it("deduplicates repeated mention ids", () => {
    const doc = makeDoc([mention("user-1"), mention("user-1"), mention("user-2")]);
    expect(extractMentionUserIds(doc)).toEqual(["user-1", "user-2"]);
  });

  it("ignores empty string ids", () => {
    const doc = makeDoc([{ type: "mention", attrs: { id: "" } }]);
    expect(extractMentionUserIds(doc)).toEqual([]);
  });

  it("does not throw on garbage attrs", () => {
    expect(() => extractMentionUserIds({ type: "doc", content: [{ type: "mention", attrs: { id: 123 } }] })).not.toThrow();
  });
});

describe("Slate (Plate) format", () => {
  describe("extractPageLinkIds", () => {
    it("returns pageId from a root-level page_link node", () => {
      expect(extractPageLinkIds([slatePageLink(1)])).toEqual([1]);
    });

    it("extracts page_link nested inside paragraph children", () => {
      expect(extractPageLinkIds([slateParagraph([slatePageLink(5)])])).toEqual([5]);
    });

    it("deduplicates repeated page_link pageIds", () => {
      expect(extractPageLinkIds([slatePageLink(3), slatePageLink(3), slatePageLink(4)])).toEqual([3, 4]);
    });

    it("returns [] when no page_link nodes exist", () => {
      expect(extractPageLinkIds([slateParagraph([{ type: "text", text: "hello" }])])).toEqual([]);
    });

    it("ignores page_link with null or undefined pageId", () => {
      expect(extractPageLinkIds([{ type: "page_link", pageId: null, children: [] }])).toEqual([]);
      expect(extractPageLinkIds([{ type: "page_link", children: [] }])).toEqual([]);
    });

    it("ignores page_link with non-number pageId", () => {
      expect(extractPageLinkIds([{ type: "page_link", pageId: "5", children: [] }])).toEqual([]);
    });
  });

  describe("extractMentionUserIds", () => {
    it("returns userId from a root-level mention node", () => {
      expect(extractMentionUserIds([slateMention("user-1")])).toEqual(["user-1"]);
    });

    it("extracts mention nested inside paragraph children", () => {
      expect(extractMentionUserIds([slateParagraph([slateMention("user-3")])])).toEqual(["user-3"]);
    });

    it("deduplicates repeated mention userIds", () => {
      expect(extractMentionUserIds([slateMention("user-1"), slateMention("user-1"), slateMention("user-2")])).toEqual(["user-1", "user-2"]);
    });

    it("returns [] when no mention nodes exist", () => {
      expect(extractMentionUserIds([slateParagraph([{ type: "text", text: "hello" }])])).toEqual([]);
    });

    it("also accepts legacy userId field", () => {
      expect(extractMentionUserIds([slateMentionLegacy("user-legacy")])).toEqual(["user-legacy"]);
    });

    it("ignores mention with empty string userId", () => {
      expect(extractMentionUserIds([{ type: "mention", key: "", children: [] }])).toEqual([]);
    });

    it("ignores mention with non-string userId", () => {
      expect(extractMentionUserIds([{ type: "mention", key: 123, children: [] }])).toEqual([]);
    });
  });
});
