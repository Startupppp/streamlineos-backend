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

describe("columns that belong to another record", () => {
  /**
   * The failure this guard exists for, stated once.
   *
   * `email`, `phone`, `taxNumber`, `website` and `name` are what
   * `party-duplicates` matches on, so a value from somebody else landing in one
   * of them does not make a slightly wrong record — it makes the wrong record.
   * One rep owns two hundred accounts, so `Account Owner Email` read as the
   * customer's address gives two hundred rows one identity, and the scorer
   * merges anything sharing one above 0.85.
   */
  it("keeps another person's contact details out of the identity columns", () => {
    for (const header of [
      "Owner Email",
      "Account Owner Email",
      "Account Manager Email",
      "Created By Email",
      "Assistant Phone",
      "Asst. Phone",
    ])
      expect(mapColumn(header)).toEqual({ kind: "custom", key: expect.any(String) });
  });

  it("keeps a related company out of the name column", () => {
    // Salesforce and Zoho both ship "Parent Account"; HubSpot ships
    // "Associated Company" on every contacts export.
    for (const header of ["Parent Account", "Ultimate Parent Account", "Associated Company"])
      expect(mapColumn(header)).toEqual({ kind: "custom", key: expect.any(String) });
  });

  /**
   * Pipedrive spells every header `Entity - Field`, so a Persons export carries
   * the person's company under a header whose head noun is a synonym of `name`.
   * Read as the party's own name, every person at one company collapses into
   * that company.
   */
  it("reads Pipedrive's entity prefix as naming a different record", () => {
    for (const header of ["Person - Organization", "Deal - Organization", "Activity - Organization"])
      expect(mapColumn(header)).toEqual({ kind: "custom", key: expect.any(String) });

    // The person's own columns are unaffected: same prefix, its own fields.
    expect(mapColumn("Person - Name")).toMatchObject({ kind: "mapped", field: "name" });
    expect(mapColumn("Person - Email")).toMatchObject({ kind: "mapped", field: "email" });
  });

  /**
   * The guard must not fire on a qualifier that describes the row rather than
   * pointing away from it, or a file of customers loses its phone numbers.
   */
  it("leaves the row's own qualified columns alone", () => {
    expect(mapColumn("Company Phone")).toMatchObject({ kind: "mapped", field: "phone" });
    expect(mapColumn("Billing Email")).toMatchObject({ kind: "mapped", field: "email" });
    expect(mapColumn("Primary Contact Email")).toMatchObject({ kind: "mapped", field: "email" });
    expect(mapColumn("Company Domain Name")).toMatchObject({ kind: "mapped", field: "website" });
    // "Company / Account" is one header naming one thing, not a cross-reference
    // from a company to an account.
    expect(mapColumn("Company / Account")).toMatchObject({ kind: "mapped", field: "name" });
  });

  /**
   * A location label, not a URL. `website` is a blocking key, so reading
   * "HQ" as a host gives every account at one office the same one.
   */
  it("does not read Salesforce's site label as a website", () => {
    expect(mapColumn("Account Site")).toEqual({ kind: "custom", key: "account_site" });
    expect(mapColumn("Web Site")).toMatchObject({ kind: "mapped", field: "website" });
  });

  it("recognises a timestamp Pipedrive spells without a date word", () => {
    expect(mapColumn("Organization - Created")).toEqual({ kind: "unmapped" });
    expect(mapColumn("Person - Updated")).toEqual({ kind: "unmapped" });
  });
});
