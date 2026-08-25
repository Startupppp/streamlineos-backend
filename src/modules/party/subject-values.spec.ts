import type { SubjectFieldDefinition } from "../../db/schema/party/subjects";
import {
  deriveTitle,
  normaliseSubjectValues,
  validateFieldDefinitions,
  validateSubjectValues,
} from "./subject-values";

const propertyFields: SubjectFieldDefinition[] = [
  { name: "address", label: "Address", kind: "text", required: true },
  { name: "bedrooms", label: "Bedrooms", kind: "number" },
  { name: "askingPrice", label: "Asking price", kind: "money" },
  { name: "availableFrom", label: "Available from", kind: "date" },
  {
    name: "listingStatus",
    label: "Listing status",
    kind: "select",
    options: [
      { value: "listed", label: "Listed", tone: "success" },
      { value: "under-offer", label: "Under offer", tone: "warning" },
      { value: "sold", label: "Sold", tone: "neutral" },
    ],
  },
];

describe("validateSubjectValues", () => {
  it("accepts values matching the declaration", () => {
    expect(
      validateSubjectValues(propertyFields, {
        address: "12 Harbour Lane",
        bedrooms: 3,
        askingPrice: "450000",
        availableFrom: "2026-09-01",
        listingStatus: "listed",
      }),
    ).toEqual([]);
  });

  it("reports a missing required field by its label", () => {
    expect(validateSubjectValues(propertyFields, { bedrooms: 3 })).toEqual([
      { field: "address", message: "Address is required" },
    ]);
  });

  it("allows an optional field to be absent", () => {
    expect(validateSubjectValues(propertyFields, { address: "12 Harbour Lane" })).toEqual([]);
  });

  it("treats whitespace as absent, so a blank required field is caught", () => {
    expect(validateSubjectValues(propertyFields, { address: "   " })).toEqual([
      { field: "address", message: "Address is required" },
    ]);
  });

  it("accepts a number as a number or as its string form", () => {
    expect(
      validateSubjectValues(propertyFields, { address: "x", bedrooms: 3, askingPrice: "450000" }),
    ).toEqual([]);
  });

  it("rejects a number that is not one", () => {
    const problems = validateSubjectValues(propertyFields, { address: "x", bedrooms: "three" });
    expect(problems).toEqual([{ field: "bedrooms", message: "Bedrooms must be a number" }]);
  });

  it("rejects an unparseable date", () => {
    const problems = validateSubjectValues(propertyFields, {
      address: "x",
      availableFrom: "next tuesday",
    });
    expect(problems[0]?.message).toContain("must be a date");
  });

  it("rejects a select value the type does not declare", () => {
    // A value no form could have produced is a bug or a tampered payload.
    const problems = validateSubjectValues(propertyFields, {
      address: "x",
      listingStatus: "withdrawn",
    });
    expect(problems[0]?.message).toContain("must be one of: listed, under-offer, sold");
  });

  it("rejects a key the type never declared, rather than storing it", () => {
    const problems = validateSubjectValues(propertyFields, { address: "x", bedroomz: 3 });
    expect(problems).toEqual([
      { field: "bedroomz", message: '"bedroomz" is not a field on this type' },
    ]);
  });

  it("collects every problem rather than stopping at the first", () => {
    const problems = validateSubjectValues(propertyFields, {
      bedrooms: "three",
      listingStatus: "withdrawn",
    });
    expect(problems.map((problem) => problem.field).sort()).toEqual([
      "address",
      "bedrooms",
      "listingStatus",
    ]);
  });

  it("handles a record with no values at all", () => {
    expect(validateSubjectValues(propertyFields, null)).toEqual([
      { field: "address", message: "Address is required" },
    ]);
  });

  it("validates an email field", () => {
    const fields: SubjectFieldDefinition[] = [
      { name: "contact", label: "Contact", kind: "email" },
    ];
    expect(validateSubjectValues(fields, { contact: "not-an-email" })[0]?.message).toContain(
      "must be an email address",
    );
    expect(validateSubjectValues(fields, { contact: "a@b.example" })).toEqual([]);
  });
});

describe("normaliseSubjectValues", () => {
  it("keeps only declared fields, dropping anything else", () => {
    expect(
      normaliseSubjectValues(propertyFields, { address: "x", bedroomz: 3, bedrooms: 2 }),
    ).toEqual({ address: "x", bedrooms: 2 });
  });

  it("orders keys as the type declares them, not as the client sent them", () => {
    // Declared order is what the rendered form and detail view follow.
    const out = normaliseSubjectValues(propertyFields, { listingStatus: "sold", address: "x" });
    expect(Object.keys(out)).toEqual(["address", "listingStatus"]);
  });

  it("drops blanks rather than storing empty strings", () => {
    expect(normaliseSubjectValues(propertyFields, { address: "x", bedrooms: "  " })).toEqual({
      address: "x",
    });
  });
});

describe("deriveTitle", () => {
  it("reads the field the type nominates", () => {
    expect(deriveTitle("address", { address: "12 Harbour Lane" }, "Untitled")).toBe(
      "12 Harbour Lane",
    );
  });

  it("accepts a numeric title", () => {
    expect(deriveTitle("reference", { reference: 4021 }, "Untitled")).toBe("4021");
  });

  it("falls back rather than storing an empty title", () => {
    expect(deriveTitle("address", { address: "  " }, "Untitled")).toBe("Untitled");
    expect(deriveTitle("address", {}, "Untitled")).toBe("Untitled");
  });
});

describe("validateFieldDefinitions", () => {
  it("accepts a well-formed declaration", () => {
    expect(validateFieldDefinitions(propertyFields, "address")).toEqual([]);
  });

  it("rejects a type that declares nothing", () => {
    expect(validateFieldDefinitions([], "address")[0]?.message).toContain("at least one field");
  });

  it("rejects a duplicate field name, which would share one value", () => {
    const fields: SubjectFieldDefinition[] = [
      { name: "a", label: "A", kind: "text" },
      { name: "a", label: "Also A", kind: "text" },
    ];
    expect(validateFieldDefinitions(fields, "a").some((p) => p.message.includes("duplicate"))).toBe(
      true,
    );
  });

  it("rejects a select with no options, which renders an empty dropdown", () => {
    const fields: SubjectFieldDefinition[] = [
      { name: "stage", label: "Stage", kind: "select" },
    ];
    expect(validateFieldDefinitions(fields, "stage")[0]?.message).toContain("needs options");
  });

  it("rejects a titleField that is not a declared field", () => {
    expect(validateFieldDefinitions(propertyFields, "nope")[0]?.message).toContain(
      'titleField "nope"',
    );
  });

  it("rejects a field name the platform already uses on every subject", () => {
    // `reference` and `status` are columns on the subject itself. A declared
    // field with the same name renders twice, and the platform column wins the
    // read while the declared one is what got written.
    const fields: SubjectFieldDefinition[] = [
      { name: "address", label: "Address", kind: "text" },
      { name: "status", label: "Listing status", kind: "text" },
    ];
    expect(validateFieldDefinitions(fields, "address")[0]?.message).toContain(
      "reserved",
    );
  });

  it("names every reserved collision rather than only the first", () => {
    const fields: SubjectFieldDefinition[] = [
      { name: "address", label: "Address", kind: "text" },
      { name: "status", label: "Status", kind: "text" },
      { name: "reference", label: "Reference", kind: "text" },
      { name: "title", label: "Title", kind: "text" },
    ];
    const reserved = validateFieldDefinitions(fields, "address")
      .filter((problem) => problem.message.includes("reserved"))
      .map((problem) => problem.field);
    expect(reserved.sort()).toEqual(["reference", "status", "title"]);
  });

  it("allows a name that merely contains a reserved word", () => {
    const fields: SubjectFieldDefinition[] = [
      { name: "status-note", label: "Status note", kind: "text" },
      { name: "reference-date", label: "Reference date", kind: "date" },
    ];
    expect(validateFieldDefinitions(fields, "status-note")).toEqual([]);
  });

  it("rejects a field with no label", () => {
    const fields: SubjectFieldDefinition[] = [{ name: "a", label: "", kind: "text" }];
    expect(validateFieldDefinitions(fields, "a").some((p) => p.message.includes("label"))).toBe(
      true,
    );
  });
});
