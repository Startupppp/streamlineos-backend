import {
  chunkText,
  KB_CHUNK_OVERLAP_CHARS,
  KB_CHUNK_SIZE_CHARS,
  KB_MAX_CHUNKS_PER_DOCUMENT,
} from "./kb-chunk-utils";

const FIRST_WAR_TAIL =
  "The First Carnatic War closed with the Treaty of Aix-la-Chapelle in 1748, which returned Madras to the British and confirmed Maria Theresa as ruler of Austria.";
const SECOND_WAR_HEAD =
  "Second Carnatic War\n\nThe Second Carnatic War ran from 1749 to 1754 and strengthened the British position in southern India.";

describe("chunkText — a chunk must not straddle a section boundary and carry one section's facts into the next", () => {
  it("ends a chunk at the blank line before a new section rather than mid-sentence", () => {
    const filler = "a".repeat(KB_CHUNK_SIZE_CHARS - 250);
    const document = `${filler}\n\n${FIRST_WAR_TAIL}\n\n${SECOND_WAR_HEAD}`;

    const chunks = chunkText(document);

    const straddling = chunks.filter(
      (chunk) =>
        chunk.includes("Treaty of Aix-la-Chapelle") && chunk.includes("ran from 1749 to 1754"),
    );
    expect(straddling).toHaveLength(0);
  });

  it("falls back to a word boundary when the window holds no paragraph or line break", () => {
    const document = `${"word ".repeat(600)}end`;

    const chunks = chunkText(document);

    for (const chunk of chunks.slice(0, -1)) expect(chunk.endsWith("word")).toBe(true);
  });

  it("splits unbroken text at the window edge rather than looping forever", () => {
    const document = "b".repeat(KB_CHUNK_SIZE_CHARS * 3);

    const chunks = chunkText(document);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(KB_CHUNK_SIZE_CHARS);
  });

  it("does not carry the previous section back in as overlap when the split was a paragraph break", () => {
    const filler = "a".repeat(KB_CHUNK_SIZE_CHARS - 250);
    const document = `${filler}\n\n${FIRST_WAR_TAIL}\n\n${SECOND_WAR_HEAD}`;

    const chunks = chunkText(document);

    const withSecondWarBody = chunks.filter((chunk) => chunk.includes("ran from 1749 to 1754"));
    expect(withSecondWarBody.length).toBeGreaterThan(0);
    for (const chunk of withSecondWarBody)
      expect(chunk).not.toContain("Treaty of Aix-la-Chapelle");
  });

  it("keeps the overlap window so a sentence spanning a boundary survives in one chunk", () => {
    const document = `${"c".repeat(KB_CHUNK_SIZE_CHARS)} tail marker text`;

    const chunks = chunkText(document);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[1]?.length).toBeLessThanOrEqual(
      KB_CHUNK_SIZE_CHARS + KB_CHUNK_OVERLAP_CHARS,
    );
  });

  it("returns nothing for text that is empty or whitespace only", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\n  ")).toEqual([]);
  });

  it("stops at the per-document chunk ceiling so one upload cannot exhaust the embedding budget", () => {
    const document = "d".repeat(KB_CHUNK_SIZE_CHARS * (KB_MAX_CHUNKS_PER_DOCUMENT + 50));

    expect(chunkText(document).length).toBeLessThanOrEqual(KB_MAX_CHUNKS_PER_DOCUMENT);
  });
});
