import { buildCsv } from "./finance-reports-csv.util";

describe("buildCsv", () => {
  describe("basic structure", () => {
    it("produces a header row followed by data rows", () => {
      const result = buildCsv(["Name", "Amount"], [["Alice", "100"]]);
      const lines = result.split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe('"Name","Amount"');
      expect(lines[1]).toBe('"Alice","100"');
    });

    it("returns only header row when no data rows", () => {
      const result = buildCsv(["Col1", "Col2"], []);
      const lines = result.split("\n");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toBe('"Col1","Col2"');
    });
  });

  describe("CSV escaping", () => {
    it("wraps every cell in double quotes", () => {
      const result = buildCsv(["H"], [["value"]]);
      expect(result).toContain('"value"');
    });

    it("escapes commas inside a cell with surrounding quotes", () => {
      const result = buildCsv(["Note"], [["one, two"]]);
      expect(result).toContain('"one, two"');
    });

    it("escapes embedded double-quotes by doubling them", () => {
      const result = buildCsv(["Note"], [['say "hello"']]);
      expect(result).toContain('"say ""hello"""');
    });

    it("handles newlines inside a cell (kept within quotes)", () => {
      const result = buildCsv(["Note"], [["line1\nline2"]]);
      expect(result).toContain('"line1\nline2"');
    });

    it("converts null/undefined cells to empty string", () => {
      const result = buildCsv(["A", "B"], [[null, undefined]]);
      const dataLine = result.split("\n")[1];
      expect(dataLine).toBe('"",""');
    });
  });

  describe("10k row cap", () => {
    it("includes all rows when count is exactly 10000", () => {
      const rows: unknown[][] = Array.from({ length: 10000 }, (_, i) => [String(i)]);
      const result = buildCsv(["n"], rows);
      const lines = result.split("\n");
      expect(lines).toHaveLength(10001);
    });

    it("caps to first 10000 data rows when input exceeds 10000", () => {
      const rows: unknown[][] = Array.from({ length: 10001 }, (_, i) => [String(i)]);
      const result = buildCsv(["n"], rows);
      const lines = result.split("\n");
      expect(lines).toHaveLength(10001);
      const lastLine = lines[lines.length - 1];
      expect(lastLine).toBe('"9999"');
    });
  });

  describe("multiple columns", () => {
    it("joins columns with commas in each row", () => {
      const result = buildCsv(["A", "B", "C"], [["x", "y", "z"]]);
      const lines = result.split("\n");
      expect(lines[1]).toBe('"x","y","z"');
    });
  });
});
