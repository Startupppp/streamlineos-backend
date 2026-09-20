import {
  buildKbContext,
  kbDocumentKey,
  KB_ASK_CONTEXT_BUDGET,
  KB_BRIEF_CONTEXT_BUDGET,
  ASK_SYSTEM_PROMPT,
  type KbContextPassage,
} from "./kb-ask-context";
import { assemblePassages } from "./kb-ask-context";

const CARNATIC = kbDocumentKey("source", 1);
const LEAVE_POLICY = kbDocumentKey("article", 9);

function passage(
  documentKey: string,
  documentTitle: string,
  passageIndex: number | null,
  text: string,
): KbContextPassage {
  return { documentKey, documentTitle, passageIndex, text };
}

const firstCarnaticWar = passage(
  CARNATIC,
  "Carnatic Wars",
  2,
  "The First Carnatic War ended with the Treaty of Aix-la-Chapelle in 1748, which returned Madras to the British and confirmed Maria Theresa as the ruler of Austria.",
);
const secondCarnaticWar = passage(
  CARNATIC,
  "Carnatic Wars",
  7,
  "The Second Carnatic War lasted from 1749 to 1754 and strengthened the British position in southern India.",
);

describe("KB ask context — two sections of one document must not read as one continuous passage", () => {
  it("labels every excerpt with the document it came from and its position in that document", () => {
    const context = buildKbContext([secondCarnaticWar, firstCarnaticWar]);

    expect(context).toContain("[Document 1 — Carnatic Wars | excerpt 3]");
    expect(context).toContain("[Document 1 — Carnatic Wars | excerpt 8]");
  });

  it("orders excerpts of one document by document position, not by similarity rank", () => {
    const context = buildKbContext([secondCarnaticWar, firstCarnaticWar]);

    expect(context.indexOf("Treaty of Aix-la-Chapelle")).toBeLessThan(
      context.indexOf("Second Carnatic War lasted"),
    );
  });

  it("marks the excerpts between two non-adjacent passages as omitted so neither section absorbs the other's facts", () => {
    const context = buildKbContext([firstCarnaticWar, secondCarnaticWar]);

    expect(context).toContain("excerpts 4-7 are not included");
    expect(context).toContain("NOT continuous");
  });

  it("says excerpt, singular, when exactly one excerpt sits in the gap", () => {
    const context = buildKbContext([
      passage(CARNATIC, "Carnatic Wars", 0, "alpha"),
      passage(CARNATIC, "Carnatic Wars", 2, "beta"),
    ]);

    expect(context).toContain("excerpt 2 is not included");
  });

  it("emits no gap marker between consecutive excerpts, which really are continuous", () => {
    const context = buildKbContext([
      passage(CARNATIC, "Carnatic Wars", 6, "alpha"),
      passage(CARNATIC, "Carnatic Wars", 7, "beta"),
    ]);

    expect(context).not.toContain("not included");
  });

  it("separates two different documents and numbers them apart", () => {
    const context = buildKbContext([
      secondCarnaticWar,
      passage(LEAVE_POLICY, "Leave policy", 0, "Employees accrue 18 days of paid leave."),
    ]);

    expect(context).toContain("[Document 1 — Carnatic Wars | excerpt 8]");
    expect(context).toContain("[Document 2 — Leave policy | excerpt 1]");
    expect(context).toContain("\n\n---\n\n");
  });

  it("keeps a document's first-seen retrieval rank when deciding document order", () => {
    const context = buildKbContext([
      passage(LEAVE_POLICY, "Leave policy", 4, "policy text"),
      secondCarnaticWar,
      passage(LEAVE_POLICY, "Leave policy", 1, "earlier policy text"),
    ]);

    expect(context.indexOf("Document 1 — Leave policy")).toBeLessThan(
      context.indexOf("Document 2 — Carnatic Wars"),
    );
  });

  it("marks a whole-document fallback as an opening extract rather than an excerpt of unknown position", () => {
    const context = buildKbContext([passage(LEAVE_POLICY, "Leave policy", null, "policy text")]);

    expect(context).toContain("[Document 1 — Leave policy | opening extract]");
  });

  it("instructs the model that passages from different documents and non-adjacent excerpts are different material", () => {
    expect(ASK_SYSTEM_PROMPT).toContain("non-adjacent excerpts");
    expect(ASK_SYSTEM_PROMPT).toContain("not continuous");
  });
});

describe("KB ask context — bounds", () => {
  it("keeps at most the per-document passage cap, preferring the ones retrieval ranked first", () => {
    const many = Array.from({ length: 10 }, (_unused, index) =>
      passage(CARNATIC, "Carnatic Wars", index, `body ${index}`),
    );

    const context = buildKbContext(many);

    const kept = [...context.matchAll(/\| excerpt \d+\]/g)];
    expect(kept).toHaveLength(KB_ASK_CONTEXT_BUDGET.maxPassagesPerDocument);
    expect(context).toContain("body 0");
    expect(context).not.toContain("body 9");
  });

  it("truncates a single passage at the per-passage cap rather than spending the whole budget on it", () => {
    const context = buildKbContext([
      passage(CARNATIC, "Carnatic Wars", 0, "x".repeat(KB_ASK_CONTEXT_BUDGET.maxPassageChars + 500)),
    ]);

    expect(context).toContain("x".repeat(KB_ASK_CONTEXT_BUDGET.maxPassageChars));
    expect(context).not.toContain("x".repeat(KB_ASK_CONTEXT_BUDGET.maxPassageChars + 1));
  });

  it("stops adding documents once the total budget is spent", () => {
    const filler = "y".repeat(KB_ASK_CONTEXT_BUDGET.maxPassageChars);
    const documents = Array.from({ length: 40 }, (_unused, index) =>
      passage(kbDocumentKey("source", index + 100), `Doc ${index}`, 0, filler),
    );

    const context = buildKbContext(documents);

    expect(context.length).toBeLessThanOrEqual(KB_ASK_CONTEXT_BUDGET.maxTotalChars);
  });

  it("holds the research brief to its own tighter budget rather than the ask budget", () => {
    const filler = "z".repeat(KB_BRIEF_CONTEXT_BUDGET.maxPassageChars * 3);
    const documents = Array.from({ length: 40 }, (_unused, index) =>
      passage(kbDocumentKey("source", index + 200), `Doc ${index}`, 0, filler),
    );

    const context = buildKbContext(documents, KB_BRIEF_CONTEXT_BUDGET);

    expect(context.length).toBeLessThanOrEqual(KB_BRIEF_CONTEXT_BUDGET.maxTotalChars);
  });

  it("drops an empty passage instead of emitting a label with nothing under it", () => {
    const context = buildKbContext([passage(CARNATIC, "Carnatic Wars", 3, "   ")]);

    expect(context).toBe("");
  });

  it("drops a duplicate excerpt of the same document position", () => {
    const context = buildKbContext([
      passage(CARNATIC, "Carnatic Wars", 3, "first copy"),
      passage(CARNATIC, "Carnatic Wars", 3, "second copy"),
    ]);

    expect(context).toContain("first copy");
    expect(context).not.toContain("second copy");
  });
});

describe("assemblePassages — the matched chunk reaches the prompt, not the head of the document", () => {
  const page = {
    kind: "page" as const,
    id: 4,
    title: "Carnatic Wars",
    contentText:
      "The First Carnatic War ended with the Treaty of Aix-la-Chapelle in 1748, returning Madras to the British.",
  };

  it("prefers a matched passage over the document's opening text when the vector search found one", () => {
    const matched = passage(
      kbDocumentKey("page", 4),
      "Carnatic Wars",
      7,
      "The Second Carnatic War lasted from 1749 to 1754.",
    );

    const assembled = assemblePassages([page], [], [matched]);

    expect(assembled).toEqual([matched]);
  });

  it("falls back to the document's opening text only when no passage matched that document", () => {
    const assembled = assemblePassages([page], [], []);

    expect(assembled).toEqual([
      {
        documentKey: kbDocumentKey("page", 4),
        documentTitle: "Carnatic Wars",
        passageIndex: null,
        text: page.contentText,
      },
    ]);
  });

  it("never attributes one document's passages to another document that happens to share its id", () => {
    const article = { kind: "article" as const, id: 4, title: "Other doc", contentText: "other" };
    const pagePassage = passage(kbDocumentKey("page", 4), "Carnatic Wars", 1, "page body");

    const assembled = assemblePassages([article, page], [], [pagePassage]);

    expect(assembled[0]?.documentKey).toBe(kbDocumentKey("article", 4));
    expect(assembled[0]?.text).toBe("other");
    expect(assembled[1]).toEqual(pagePassage);
  });

  it("carries every passage a source document contributed, not just its best-matching one", () => {
    const sourceDocument = {
      passages: [firstCarnaticWar, secondCarnaticWar],
    };

    const assembled = assemblePassages([], [sourceDocument], []);

    expect(assembled).toEqual([firstCarnaticWar, secondCarnaticWar]);
  });
});
