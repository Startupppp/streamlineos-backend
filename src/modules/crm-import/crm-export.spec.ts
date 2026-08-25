import { toCsv } from "./crm-export.service";

describe("toCsv", () => {
  it("writes a header row and one line per record", () => {
    expect(toCsv([{ name: "Acme", email: "ops@acme.example" }])).toBe(
      "name,email\nAcme,ops@acme.example",
    );
  });

  /**
   * The rules people actually get wrong. Each of these silently gains a column
   * when the file is read back, which is how an export corrupts a migration.
   */
  it("quotes a value containing a comma", () => {
    expect(toCsv([{ name: "Acme, Inc" }])).toBe('name\n"Acme, Inc"');
  });

  it("doubles embedded quotes", () => {
    expect(toCsv([{ name: 'The "Real" Acme' }])).toBe('name\n"The ""Real"" Acme"');
  });

  it("quotes a value containing a newline", () => {
    expect(toCsv([{ notes: "line one\nline two" }])).toBe('notes\n"line one\nline two"');
  });

  it("takes the union of keys, not the first row's", () => {
    // A nullable column absent from row one would otherwise drop out entirely.
    expect(toCsv([{ name: "Acme" }, { name: "Globex", phone: "123" }])).toBe(
      "name,phone\nAcme,\nGlobex,123",
    );
  });

  it("writes a custom-fields object as JSON, not [object Object]", () => {
    expect(toCsv([{ customFields: { territory: "North" } }])).toBe(
      'customFields\n"{""territory"":""North""}"',
    );
  });

  it("writes dates as ISO rather than a locale string", () => {
    expect(toCsv([{ createdAt: new Date("2026-08-25T10:00:00.000Z") }])).toBe(
      "createdAt\n2026-08-25T10:00:00.000Z",
    );
  });

  it("writes an empty cell for null and undefined alike", () => {
    expect(toCsv([{ a: null, b: undefined, c: 0, d: false }])).toBe("a,b,c,d\n,,0,false");
  });

  it("returns nothing for no rows rather than a bare header", () => {
    expect(toCsv([])).toBe("");
  });
});
