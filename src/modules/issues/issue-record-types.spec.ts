import { ISSUE_RECORD_TYPES } from "../../db/schema/crm/issue-records";
import {
  ISSUE_LAYOUTS,
  ageDays,
  issueRecordRow,
  type IssueRecordLayout,
  type IssueRecordSource,
} from "./issue-record-types";

/**
 * The renderer's own checks, run against these three descriptions here.
 *
 * `validateLayout` lives on the frontend and cannot be imported across the
 * repository boundary, so its rules are restated. That is not duplication for
 * its own sake: a description that names a field it does not define renders as a
 * permanently empty column, on every row, and nothing else in the stack fails.
 * The point of this file is that the failure is a red test rather than a screen
 * somebody eventually notices.
 */
function problems(layout: IssueRecordLayout): string[] {
  const found: string[] = [];
  const known = new Set(layout.fields.map((field) => field.name));

  const require = (name: string, where: string): void => {
    if (!known.has(name)) found.push(`${where}: unknown field "${name}"`);
  };

  require(layout.titleField, "titleField");
  layout.list.columns.forEach((column, index) => {
    require(column.field, `list.columns[${index}]`);
    if (column.subtitle) require(column.subtitle, `list.columns[${index}].subtitle`);
  });

  for (const [area, sections] of [
    ["detail", layout.detail.sections],
    ["form", layout.form.sections],
  ] as const)
    sections.forEach((section, index) =>
      section.fields.forEach((name) => require(name, `${area}.sections[${index}]`)),
    );

  if (!layout.list.columns.some((column) => column.primary))
    found.push("list.columns: no primary column, so the mobile card has no title");

  const names = layout.fields.map((field) => field.name);
  for (const name of new Set(names.filter((n, i) => names.indexOf(n) !== i)))
    found.push(`fields: duplicate field "${name}"`);

  return found;
}

const SOURCE: IssueRecordSource = {
  issueRecordId: "rec_1",
  recordType: "complaint",
  title: "Delivery arrived damaged",
  severity: "high",
  stage: "escalated",
  ownerUserId: "user_7",
  partyId: "party_3",
  partyName: "Northwind Traders",
  dealId: 42,
  dealTitle: "Northwind renewal",
  dueAt: new Date("2026-01-10T00:00:00.000Z"),
  openedAt: new Date("2026-01-01T00:00:00.000Z"),
  acknowledgedAt: null,
  closedAt: null,
  details: null,
  reference: "CMP-9",
};

describe("issue record types as renderer descriptions", () => {
  it("declares all three", () => {
    expect(Object.keys(ISSUE_LAYOUTS).sort()).toEqual([...ISSUE_RECORD_TYPES].sort());
  });

  it.each(ISSUE_RECORD_TYPES)("%s is a valid layout", (recordType) => {
    expect(problems(ISSUE_LAYOUTS[recordType])).toEqual([]);
  });

  /**
   * The one that makes the whole arrangement work. A row missing a key the
   * layout names is an empty column; a key the layout does not name is dead
   * weight travelling on every row of every page.
   */
  it.each(ISSUE_RECORD_TYPES)("projects every field %s declares", (recordType) => {
    const row = issueRecordRow(SOURCE, Date.UTC(2026, 0, 11));
    for (const field of ISSUE_LAYOUTS[recordType].fields)
      expect(Object.keys(row)).toContain(field.name);
  });

  /**
   * Criterion 4's other half. The renderer's `formFields` drops read-only
   * fields, so a read-only `stage` means the generated form is physically unable
   * to move a record's stage — which is what leaves the transition endpoint as
   * the only path and the ledger unbypassable. A writable stage control would
   * have made that a convention instead of a fact.
   */
  it.each(ISSUE_RECORD_TYPES)("never offers %s's stage as an editable control", (recordType) => {
    const layout = ISSUE_LAYOUTS[recordType];
    const stage = layout.fields.find((field) => field.name === "stage");
    expect(stage?.readOnly).toBe(true);
    for (const section of layout.form.sections) expect(section.fields).not.toContain("stage");
  });

  /** Criterion 2, as the form sees it. */
  it("requires a complaint's party and does not require an issue's", () => {
    const partyOn = (type: "complaint" | "issue") =>
      ISSUE_LAYOUTS[type].fields.find((field) => field.name === "partyId");
    expect(partyOn("complaint")?.required).toBe(true);
    expect(partyOn("issue")?.required).toBeUndefined();
  });

  it("offers exactly the schema's severity bands", () => {
    const severity = ISSUE_LAYOUTS.issue.fields.find((field) => field.name === "severity");
    expect(severity?.options?.map((option) => option.value)).toEqual(["high", "medium", "low"]);
  });

  it("serialises dates as strings the renderer's date kind can read", () => {
    const row = issueRecordRow(SOURCE, Date.UTC(2026, 0, 11));
    expect(row.openedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(row.dueAt).toBe("2026-01-10T00:00:00.000Z");
    expect(row.acknowledgedAt).toBeNull();
  });
});

describe("the clock", () => {
  it("counts from opening while a record is still open", () => {
    expect(ageDays(SOURCE, Date.UTC(2026, 0, 11))).toBe(10);
  });

  /**
   * A closed record answers "how long did it take", not "how long ago was it".
   * An age that keeps climbing after closure makes every historic complaint look
   * like the worst one on the board.
   */
  it("stops at closure", () => {
    const closed = { ...SOURCE, closedAt: new Date("2026-01-04T00:00:00.000Z") };
    expect(ageDays(closed, Date.UTC(2026, 5, 1))).toBe(3);
  });

  it("never goes negative on a clock skewed into the future", () => {
    expect(ageDays(SOURCE, Date.UTC(2025, 0, 1))).toBe(0);
  });
});
