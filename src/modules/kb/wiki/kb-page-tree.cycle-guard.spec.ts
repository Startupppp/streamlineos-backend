import { isDescendant } from "./kb-page-tree.service";

type PageStub = { id: number; parentPageId: number | null };

describe("isDescendant", () => {
  const pages: PageStub[] = [
    { id: 1, parentPageId: null },
    { id: 2, parentPageId: 1 },
    { id: 3, parentPageId: 2 },
    { id: 4, parentPageId: 3 },
    { id: 5, parentPageId: 1 },
  ];

  it("returns false when candidate is the root", () => {
    expect(isDescendant(pages, 1, 1)).toBe(false);
  });

  it("returns true for direct child", () => {
    expect(isDescendant(pages, 1, 2)).toBe(true);
  });

  it("returns true for deep descendant", () => {
    expect(isDescendant(pages, 1, 4)).toBe(true);
  });

  it("returns false for sibling branch", () => {
    expect(isDescendant(pages, 5, 3)).toBe(false);
  });

  it("returns false when ancestor is deeper in the tree", () => {
    expect(isDescendant(pages, 4, 2)).toBe(false);
  });

  it("handles empty page list", () => {
    expect(isDescendant([], 1, 2)).toBe(false);
  });

  it("handles cycle in data without infinite loop", () => {
    const cyclic: PageStub[] = [
      { id: 1, parentPageId: 2 },
      { id: 2, parentPageId: 1 },
    ];
    expect(isDescendant(cyclic, 1, 2)).toBe(true);
  });
});
