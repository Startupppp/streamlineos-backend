import { mapColumn, mapColumns } from "./column-mapping";
import {
  ALL_IMPORT_FIELDS,
  coerceFor,
  fieldsFor,
  IMPORT_ENTITIES,
  isImportEntity,
  isFieldOf,
  matchStrategyFor,
  requiredFieldOf,
} from "./import-entities";

/**
 * The entity dimension, tested where it is pure.
 *
 * The registry is the only place that knows what a field vocabulary is, so
 * these are the tests that stop a fifth entity being added as a fifth code path.
 */
describe("the import entities", () => {
  it("names the four entities a file can be for", () => {
    expect([...IMPORT_ENTITIES]).toEqual(["party", "subject", "pipeline", "activity"]);
  });

  it("narrows a string a person sent us", () => {
    expect(isImportEntity("subject")).toBe(true);
    expect(isImportEntity("contact")).toBe(false);
  });

  it("gives every entity a field it cannot be written without", () => {
    for (const entity of IMPORT_ENTITIES) {
      const required = requiredFieldOf(entity);
      expect(fieldsFor(entity)).toContain(required.field);
      expect(required.reason.length).toBeGreaterThan(0);
    }
  });

  it("collects every entity's fields into the list an override may name", () => {
    for (const entity of IMPORT_ENTITIES)
      for (const field of fieldsFor(entity)) expect(ALL_IMPORT_FIELDS).toContain(field);
  });

  it("refuses a field that belongs to a different entity", () => {
    expect(isFieldOf("party", "taxNumber")).toBe(true);
    // `taxNumber` is a real field, but not one an activity has.
    expect(isFieldOf("activity", "taxNumber")).toBe(false);
  });
});

/**
 * The party vocabulary is frozen, deliberately.
 *
 * `mapColumn(header)` with no entity is what the mapping evals call, and the
 * gate on them has zero tolerance for a wrong column. Making the entity a
 * parameter must not move a single party answer.
 */
describe("mapColumn defaults to party", () => {
  const headers = [
    "Company Name", "Account Name", "Email", "Company Phone", "Billing Email",
    "Company Domain Name", "Account Number", "Account Owner Email", "Parent Account",
    "Primary Contact Email", "Last Modified Date", "Account Site", "GSTIN", "Territory",
  ];

  it("answers the same with the entity left out as with party named", () => {
    for (const header of headers) expect(mapColumn(header)).toEqual(mapColumn(header, "party"));
  });

  it("still reads the head noun", () => {
    expect(mapColumn("Company Phone", "party")).toMatchObject({ kind: "mapped", field: "phone" });
    expect(mapColumn("Account Number", "party")).not.toMatchObject({ field: "name" });
  });
});

describe("mapColumn for a subject", () => {
  it("reads the columns a subject actually has", () => {
    expect(mapColumn("Title", "subject")).toMatchObject({ kind: "mapped", field: "title" });
    expect(mapColumn("Reference", "subject")).toMatchObject({ kind: "mapped", field: "reference" });
    expect(mapColumn("Status", "subject")).toMatchObject({ kind: "mapped", field: "status" });
  });

  it("recognises a listing code as the reference", () => {
    expect(mapColumn("Listing Code", "subject")).toMatchObject({ field: "reference" });
    expect(mapColumn("External ID", "subject")).toMatchObject({ field: "reference" });
  });

  /**
   * A subject type's declared fields live in `custom_fields`, so a column that
   * is not one of the three platform columns landing there is the right answer
   * rather than a failure to recognise it.
   */
  it("leaves a declared field to become a custom field", () => {
    expect(mapColumn("Bedrooms", "subject")).toEqual({ kind: "custom", key: "bedrooms" });
  });

  it("does not offer a subject file the party vocabulary", () => {
    expect(mapColumn("GSTIN", "subject")).not.toMatchObject({ kind: "mapped" });
  });
});

describe("mapColumn for a pipeline", () => {
  it("reads a deals export", () => {
    expect(mapColumn("Opportunity Name", "pipeline")).toMatchObject({ field: "name" });
    expect(mapColumn("Deal Title", "pipeline")).toMatchObject({ field: "name" });
    expect(mapColumn("Stage", "pipeline")).toMatchObject({ field: "stage" });
    expect(mapColumn("Amount", "pipeline")).toMatchObject({ field: "amount" });
    expect(mapColumn("Expected Close Date", "pipeline")).toMatchObject({ field: "closeDate" });
    expect(mapColumn("Probability", "pipeline")).toMatchObject({ field: "probability" });
    expect(mapColumn("Next Step", "pipeline")).toMatchObject({ field: "nextStep" });
  });

  /**
   * The one mistake a deals import must not make.
   *
   * "Account Name" on an Opportunities export is the customer, not the deal.
   * Read as the deal's name, every opportunity in the file is renamed after the
   * company it belongs to and the real deal names are gone.
   */
  it("does not read the account's name as the deal's name", () => {
    expect(mapColumn("Account Name", "pipeline")).toMatchObject({ field: "partyName" });
    expect(mapColumn("Company", "pipeline")).toMatchObject({ field: "partyName" });
    expect(mapColumn("Contact Name", "pipeline")).not.toMatchObject({ field: "name" });
  });

  it("still reads a bare Name as the deal's own", () => {
    expect(mapColumn("Name", "pipeline")).toMatchObject({ field: "name" });
  });
});

describe("mapColumn for an activity", () => {
  it("reads a tasks export", () => {
    expect(mapColumn("Subject", "activity")).toMatchObject({ field: "subject" });
    expect(mapColumn("Comments", "activity")).toMatchObject({ field: "body" });
    expect(mapColumn("Activity Date", "activity")).toMatchObject({ field: "occurredAt" });
    expect(mapColumn("Due Date", "activity")).toMatchObject({ field: "dueAt" });
    expect(mapColumn("Activity Type", "activity")).toMatchObject({ field: "kind" });
  });

  it("reads the column naming the record the activity belongs to", () => {
    expect(mapColumn("Related To", "activity")).toMatchObject({ field: "partyName" });
    expect(mapColumn("Account Name", "activity")).toMatchObject({ field: "partyName" });
  });

  /**
   * Another system's bookkeeping, which must not become the moment the activity
   * happened — an import of a mail folder would land every message at the time
   * somebody last touched the record.
   */
  it("leaves another system's timestamps alone", () => {
    expect(mapColumn("Last Modified Date", "activity")).toEqual({ kind: "unmapped" });
    expect(mapColumn("Created Date", "activity")).toEqual({ kind: "unmapped" });
  });
});

describe("coercion is per entity", () => {
  it("reads a competitor's word for a party type", () => {
    expect(coerceFor("party")("partyType", "Supplier")).toBe("VENDOR");
    expect(coerceFor("party")("partyType", "Wholesaler")).toBeNull();
  });

  it("reads money as minor units, so the preview shows what is written", () => {
    expect(coerceFor("pipeline")("amount", "12,500.50")).toBe("1250050");
    expect(coerceFor("pipeline")("amount", "$1,000")).toBe("100000");
    expect(coerceFor("pipeline")("amount", "not money")).toBeNull();
  });

  /**
   * `31/12/2025` is NaN in JavaScript and `12/31/2025` is not, so a file using
   * the European order would silently land on the wrong day for the first
   * twelve of every month. Refused rather than guessed, which is what the rest
   * of this module does with an ambiguity.
   */
  it("refuses a date it cannot read unambiguously", () => {
    expect(coerceFor("pipeline")("closeDate", "2026-03-14")).toBe("2026-03-14");
    expect(coerceFor("pipeline")("closeDate", "31/12/2025")).toBeNull();
  });

  it("reads a competitor's word for an activity kind", () => {
    expect(coerceFor("activity")("kind", "Phone Call")).toBe("call");
    expect(coerceFor("activity")("kind", "To Do")).toBe("task");
    expect(coerceFor("activity")("kind", "Fax")).toBeNull();
  });
});

describe("matching is per entity", () => {
  it("scores parties and keys subjects", () => {
    expect(matchStrategyFor("party").kind).toBe("fingerprint");
    expect(matchStrategyFor("subject").kind).toBe("natural-key");
  });

  /**
   * Stated rather than implied. Neither a deal nor an activity has a unique
   * business key, so an import of either always creates — and re-importing the
   * same file twice creates twice. The undo is what that leans on.
   */
  it("does not pretend a deal or an activity has an identity", () => {
    expect(matchStrategyFor("pipeline").kind).toBe("none");
    expect(matchStrategyFor("activity").kind).toBe("none");
  });
});

describe("mapColumns refuses to fill one field from two columns, per entity", () => {
  it("holds for a pipeline file", () => {
    const columns = mapColumns(["Deal Name", "Opportunity Name"], "pipeline");
    expect(columns[0]?.mapping).toMatchObject({ kind: "mapped", field: "name" });
    expect(columns[1]?.mapping).toMatchObject({ kind: "ambiguous" });
  });
});
