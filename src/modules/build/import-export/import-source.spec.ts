import { IMPORT_MAX_ROWS } from "./import-export.constants";
import { parseImportSource } from "./import-source";

describe("parseImportSource csv", () => {
  it("maps each data row onto the header columns", () => {
    const parsed = parseImportSource("csv", "title,priority\nShip it,HIGH");
    expect(parsed.fileError).toBeNull();
    expect(parsed.rows).toEqual([
      { rowNumber: 2, values: { title: "Ship it", priority: "HIGH" } },
    ]);
  });

  it("numbers rows the way a spreadsheet does, with the header as row one", () => {
    const parsed = parseImportSource("csv", "title\nA\nB");
    expect(parsed.rows.map((row) => row.rowNumber)).toEqual([2, 3]);
  });

  it("reports a column count mismatch against the offending row", () => {
    const parsed = parseImportSource("csv", "title,priority\nOnly one");
    expect(parsed.rows).toEqual([]);
    expect(parsed.rowErrors).toEqual([
      { rowNumber: 2, field: null, message: "Expected 2 columns but found 1" },
    ]);
  });

  it("rejects a repeated header column", () => {
    const parsed = parseImportSource("csv", "title,Title\nA,B");
    expect(parsed.fileError).toBe('The header row repeats the column "Title"');
  });

  it("rejects an unnamed header column", () => {
    expect(parseImportSource("csv", "title,\nA,B").fileError).toBe(
      "The header row has an unnamed column",
    );
  });

  it("drops blank separator rows", () => {
    const parsed = parseImportSource("csv", "title\nA\n\nB");
    expect(parsed.rows.map((row) => row.values.title)).toEqual(["A", "B"]);
  });

  it("drops columns an export writes but an import may not assign", () => {
    const parsed = parseImportSource("csv", "ticketNumber,title,orgId\n7,A,other-org");
    expect(parsed.rows[0]?.values).toEqual({ title: "A" });
  });

  it("rejects a file above the row bound", () => {
    const rows = Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, i) => `T${i}`).join("\n");
    expect(parseImportSource("csv", `title\n${rows}`).fileError).toBe(
      `The file has ${IMPORT_MAX_ROWS + 1} rows; the limit is ${IMPORT_MAX_ROWS}`,
    );
  });
});

describe("parseImportSource json", () => {
  it("numbers array elements from one", () => {
    const parsed = parseImportSource("json", JSON.stringify([{ title: "A" }, { title: "B" }]));
    expect(parsed.rows).toEqual([
      { rowNumber: 1, values: { title: "A" } },
      { rowNumber: 2, values: { title: "B" } },
    ]);
  });

  it("rejects malformed JSON", () => {
    expect(parseImportSource("json", "{nope").fileError).toBe("The file is not valid JSON");
  });

  it("rejects a payload that is not an array", () => {
    expect(parseImportSource("json", '{"title":"A"}').fileError).toBe(
      "The file must contain an array of rows",
    );
  });

  it("reports a non-object element as a row error", () => {
    const parsed = parseImportSource("json", JSON.stringify([{ title: "A" }, 42]));
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rowErrors).toEqual([
      { rowNumber: 2, field: null, message: "Expected an object" },
    ]);
  });
});

describe("parseImportSource bounds", () => {
  it("rejects an empty file", () => {
    expect(parseImportSource("csv", "   ").fileError).toBe("The file is empty");
  });

  it("rejects content above the byte bound", () => {
    const huge = `title\n${"x".repeat(2_000_001)}`;
    expect(parseImportSource("csv", huge).fileError).toContain("larger than");
  });
});
