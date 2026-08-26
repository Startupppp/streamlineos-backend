import { mapColumns } from "./column-mapping";
import { ANCHOR_PARTY_ID } from "./import-entities";
import { lookupKeysFor, planImport, type PlanInput } from "./import-plan";

/**
 * The planner, once it has an entity.
 *
 * Same two passes, same stored plan, same preview — the only thing that changes
 * is what a row is, how two rows are decided to be the same one, and what the
 * row has to hang off. Tested without a database, because that is the whole
 * reason the planner is pure.
 */
const plan = (input: Omit<PlanInput, "existing"> & { existing?: PlanInput["existing"] }) =>
  planImport({ existing: [], ...input });

describe("planning a subject import", () => {
  const columns = mapColumns(["Title", "Reference", "Status", "Bedrooms"], "subject");

  it("creates a subject that is new", () => {
    const result = plan({
      entity: "subject",
      columns,
      rows: [["12 Oak Lane", "REF-1", "Listed", "4"]],
    });

    expect(result.rows[0]).toMatchObject({ action: "create", rowNumber: 1 });
    expect(result.rows[0]?.values).toMatchObject({ title: "12 Oak Lane", reference: "REF-1" });
    // A subject type's declared fields live in `custom_fields`, so this is the
    // right destination rather than a column that failed to be recognised.
    expect(result.rows[0]?.customFields).toEqual({ bedrooms: "4" });
  });

  it("skips a row with no title, because there is nothing to create", () => {
    const result = plan({ entity: "subject", columns, rows: [["", "REF-9", "", ""]] });
    expect(result.rows[0]).toMatchObject({ action: "skip" });
    expect(result.rows[0]?.reason).toMatch(/no title/i);
  });

  /**
   * `uniq_subjects_org_type_reference` is a real unique index, so a reference
   * that already exists is the same record with certainty — no band of doubt to
   * hold the row in, and no second copy of a listing on every re-export.
   */
  it("updates the subject a reference already names", () => {
    const result = plan({
      entity: "subject",
      columns,
      rows: [["12 Oak Lane", "REF-1", "Listed", ""]],
      existingByKey: { "REF-1": "subject-1" },
    });

    expect(result.rows[0]).toMatchObject({ action: "update", matchedRecordId: "subject-1" });
    expect(result.summary).toMatchObject({ create: 0, update: 1 });
  });

  it("folds a reference repeated inside the file into its first line", () => {
    const result = plan({
      entity: "subject",
      columns,
      rows: [
        ["12 Oak Lane", "REF-1", "Listed", ""],
        ["12 Oak Lane", "REF-1", "", "4"],
      ],
    });

    expect(result.rows[0]).toMatchObject({ action: "create" });
    expect(result.rows[1]).toMatchObject({ action: "merge", duplicateOfRow: 1 });
    // The repeat's values fill the survivor's gaps, exactly as they do for a party.
    expect(result.rows[0]?.customFields).toEqual({ bedrooms: "4" });
  });

  it("keeps two subjects with no reference apart", () => {
    const result = plan({
      entity: "subject",
      columns,
      rows: [["12 Oak Lane", "", "", ""], ["12 Oak Lane", "", "", ""]],
    });

    expect(result.summary).toMatchObject({ create: 2, merge: 0 });
  });

  it("names the references the file uses, so the service can look them up", () => {
    const keys = lookupKeysFor("subject", columns, [
      ["12 Oak Lane", "REF-1", "", ""],
      ["9 Elm Road", "ref-2", "", ""],
    ]);

    // Case as the file spells it: the unique index behind this is on the raw
    // column, so folding case here would claim an identity Postgres denies.
    expect(keys.naturalKeys.sort()).toEqual(["REF-1", "ref-2"]);
    expect(keys.anchorKeys).toEqual([]);
  });
});

describe("planning a pipeline import", () => {
  const columns = mapColumns(
    ["Opportunity Name", "Account Name", "Stage", "Amount", "Expected Close Date"],
    "pipeline",
  );

  it("reads money as the minor units that will be written", () => {
    const result = plan({
      entity: "pipeline",
      columns,
      rows: [["Renewal", "Acme Ltd", "Proposal", "12,500.50", "2026-03-14"]],
    });

    expect(result.rows[0]?.values).toMatchObject({
      name: "Renewal",
      stage: "Proposal",
      amount: "1250050",
      closeDate: "2026-03-14",
    });
  });

  /**
   * Stated rather than implied. A deal has no unique business key — two real
   * deals can share a name, a stage and an amount — so an import of one always
   * creates, and re-importing the same file twice creates twice. The one-action
   * undo is what that leans on; inventing a key here would quietly merge two
   * genuine deals, which no undo can separate.
   */
  it("creates an identical repeat rather than folding it", () => {
    const result = plan({
      entity: "pipeline",
      columns,
      rows: [
        ["Renewal", "Acme Ltd", "Proposal", "100", "2026-03-14"],
        ["Renewal", "Acme Ltd", "Proposal", "100", "2026-03-14"],
      ],
    });

    expect(result.summary).toMatchObject({ create: 2, merge: 0, update: 0 });
  });

  it("attaches the deal to the party its account column names", () => {
    const result = plan({
      entity: "pipeline",
      columns,
      rows: [["Renewal", "Acme Ltd", "Proposal", "100", ""]],
      anchors: { "acme ltd": "party-1" },
    });

    expect(result.rows[0]?.values[ANCHOR_PARTY_ID]).toBe("party-1");
  });

  /**
   * `deals.party_id` is nullable, so an account this tenant does not have is not
   * a reason to refuse the deal — it lands unlinked and keeps the name it came
   * with as a custom field.
   */
  it("still creates a deal whose account is not in this organisation", () => {
    const result = plan({
      entity: "pipeline",
      columns,
      rows: [["Renewal", "Nobody Ltd", "Proposal", "100", ""]],
      anchors: {},
    });

    expect(result.rows[0]).toMatchObject({ action: "create" });
    expect(result.rows[0]?.values[ANCHOR_PARTY_ID]).toBeUndefined();
  });
});

describe("planning an activity import", () => {
  const columns = mapColumns(
    ["Subject", "Activity Type", "Activity Date", "Related To", "Comments"],
    "activity",
  );

  it("puts the activity on the timeline of the record it names", () => {
    const result = plan({
      entity: "activity",
      columns,
      rows: [["Kickoff call", "Phone Call", "2026-02-01T10:00:00Z", "Acme Ltd", "Went well"]],
      anchors: { "acme ltd": "party-1" },
    });

    expect(result.rows[0]).toMatchObject({ action: "create" });
    expect(result.rows[0]?.values).toMatchObject({
      subject: "Kickoff call",
      kind: "call",
      body: "Went well",
      [ANCHOR_PARTY_ID]: "party-1",
    });
  });

  /**
   * `chk_activities_one_anchor` requires an activity to belong to exactly one
   * record, so a row naming a company this tenant does not have cannot be
   * written at all. Decided in the plan so the preview shows it, rather than
   * discovered by the commit after the file was approved.
   */
  it("skips a row whose record is not in this organisation", () => {
    const result = plan({
      entity: "activity",
      columns,
      rows: [["Kickoff call", "Call", "2026-02-01T10:00:00Z", "Nobody Ltd", ""]],
      anchors: {},
    });

    expect(result.rows[0]).toMatchObject({ action: "skip" });
    expect(result.rows[0]?.reason).toMatch(/no timeline/i);
  });

  it("skips a row with no subject, because there is nothing to put on a timeline", () => {
    const result = plan({
      entity: "activity",
      columns,
      rows: [["", "Call", "", "Acme Ltd", ""]],
      anchors: { "acme ltd": "party-1" },
    });

    expect(result.rows[0]).toMatchObject({ action: "skip" });
    expect(result.rows[0]?.reason).toMatch(/no subject/i);
  });

  it("names the records the file refers to, so the service can resolve them", () => {
    const keys = lookupKeysFor("activity", columns, [
      ["Call", "", "", "Acme Ltd", ""],
      ["Call", "", "", "ACME LTD", ""],
      ["Call", "", "", "Globex", ""],
    ]);

    expect(keys.anchorKeys.sort()).toEqual(["acme ltd", "globex"]);
    expect(keys.naturalKeys).toEqual([]);
  });
});
