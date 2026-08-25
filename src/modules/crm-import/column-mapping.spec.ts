import {
  duplicateFieldAssignments,
  isImportField,
  mapColumn,
  mapColumns,
  needsConfirmation,
  normaliseHeader,
} from "./column-mapping";

describe("normaliseHeader", () => {
  it("folds the punctuation a spreadsheet adds", () => {
    for (const header of ["Company Name", "company_name", "COMPANY-NAME", "Company / Name", "  company   name  "])
      expect(normaliseHeader(header)).toBe("company name");
  });
});

describe("mapColumn", () => {
  it("recognises the same field across products", () => {
    // These are the same column in four different CRMs.
    for (const header of ["Company Name", "Account Name", "Organisation", "Customer"])
      expect(mapColumn(header)).toMatchObject({ kind: "mapped", field: "name" });
  });

  it("maps the obvious ones outright", () => {
    expect(mapColumn("Email")).toMatchObject({ kind: "mapped", field: "email", confidence: 1 });
    expect(mapColumn("GSTIN")).toMatchObject({ kind: "mapped", field: "taxNumber" });
    expect(mapColumn("Website")).toMatchObject({ kind: "mapped", field: "website" });
  });

  it("finds a field inside a longer header, less confidently", () => {
    const result = mapColumn("Primary Contact Email");
    expect(result).toMatchObject({ kind: "mapped", field: "email" });
    if (result.kind === "mapped") expect(result.confidence).toBeLessThan(1);
  });

  /**
   * English column names qualify left to right, so the rightmost match is the
   * head noun and what precedes it is describing it. Without this rule half a
   * normal export would be flagged ambiguous, and a confirmation step that asks
   * about half the file stops being read.
   */
  it("reads a qualified header as its head noun", () => {
    expect(mapColumn("Company Phone")).toMatchObject({ kind: "mapped", field: "phone" });
    expect(mapColumn("Billing Email")).toMatchObject({ kind: "mapped", field: "email" });
    expect(mapColumn("Customer Notes")).toMatchObject({ kind: "mapped", field: "notes" });
  });

  it("takes an exact synonym over any positional reading", () => {
    // "Account Status" is one field's name, not an account qualified by status.
    expect(mapColumn("Account Status")).toMatchObject({ kind: "mapped", field: "status", confidence: 1 });
  });

  it("sends an unknown column to custom fields rather than dropping it", () => {
    // A column the user can see in their file and cannot find afterwards is
    // data loss they discover months later.
    expect(mapColumn("Preferred Courier")).toEqual({ kind: "custom", key: "preferred_courier" });
  });

  it("leaves another system's identifiers alone", () => {
    for (const header of ["Record ID", "Created At", "Owner ID", "Last Modified"])
      expect(mapColumn(header)).toEqual({ kind: "unmapped" });
  });

  it("gives the same custom key for the same header from a different file", () => {
    expect(mapColumn("Preferred Courier")).toEqual(mapColumn("preferred_courier"));
  });
});

describe("mapColumns", () => {
  /**
   * A file with both `Company` and `Account Name` would otherwise map both to
   * `name`, and the second silently overwrites the first for every row.
   */
  it("never maps one field twice", () => {
    const columns = mapColumns(["Company", "Account Name", "Email"]);
    expect(columns[0]?.mapping).toMatchObject({ kind: "mapped", field: "name" });
    expect(columns[1]?.mapping.kind).toBe("ambiguous");
    expect(columns[2]?.mapping).toMatchObject({ kind: "mapped", field: "email" });
  });

  it("maps a realistic export end to end", () => {
    const columns = mapColumns([
      "Account Name", "Email", "Phone", "Website", "GSTIN", "Description", "Record ID", "Territory",
    ]);
    const byHeader = Object.fromEntries(columns.map((c) => [c.header, c.mapping]));

    expect(byHeader["Account Name"]).toMatchObject({ field: "name" });
    expect(byHeader["Email"]).toMatchObject({ field: "email" });
    expect(byHeader["GSTIN"]).toMatchObject({ field: "taxNumber" });
    expect(byHeader["Description"]).toMatchObject({ field: "notes" });
    expect(byHeader["Record ID"]).toEqual({ kind: "unmapped" });
    expect(byHeader["Territory"]).toEqual({ kind: "custom", key: "territory" });
  });
});

describe("duplicateFieldAssignments", () => {
  /**
   * `mapColumns` prevents this on the automatic path, but it runs before a
   * person's answers are applied — and an answer names a field outright, so it
   * can re-create the collision the guard exists to prevent. Reported so the
   * caller can refuse rather than let the rightmost column win every row.
   */
  it("reports the field two columns both claim", () => {
    expect(
      duplicateFieldAssignments([
        { header: "Company", mapping: { kind: "mapped", field: "name", confidence: 1 } },
        { header: "Account Name", mapping: { kind: "mapped", field: "name", confidence: 1 } },
        { header: "Email", mapping: { kind: "mapped", field: "email", confidence: 1 } },
      ]),
    ).toEqual([{ field: "name", headers: ["Company", "Account Name"] }]);
  });

  it("finds nothing in a mapping where each field comes from one column", () => {
    expect(duplicateFieldAssignments(mapColumns(["Company Name", "Email", "Phone"]))).toEqual([]);
  });
});

describe("isImportField", () => {
  it("accepts a field this import can fill and refuses anything else", () => {
    expect(isImportField("name")).toBe(true);
    expect(isImportField("partyType")).toBe(true);
    // A column of the table is not automatically a field of the import.
    expect(isImportField("partyId")).toBe(false);
    expect(isImportField("__ignore__")).toBe(false);
  });
});

describe("needsConfirmation", () => {
  /**
   * The reachable ambiguity in practice: two columns claiming one field. The
   * second would otherwise overwrite the first for every row in the file.
   */
  it("asks when two columns claim the same field", () => {
    const asked = needsConfirmation(mapColumns(["Company", "Account Name", "Email"]));
    expect(asked).toHaveLength(1);
    expect(asked[0]?.header).toBe("Account Name");
  });

  it("asks nothing about headers that each read one way", () => {
    const columns = mapColumns(["Company Phone", "Primary Contact Email", "Territory"]);
    expect(needsConfirmation(columns)).toHaveLength(0);
  });

  it("asks nothing of a clean file", () => {
    expect(needsConfirmation(mapColumns(["Company Name", "Email", "Phone"]))).toHaveLength(0);
  });
});
