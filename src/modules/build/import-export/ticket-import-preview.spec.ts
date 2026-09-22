import { parseImportSource } from "./import-source";
import { buildTicketImportPreview, titleKey } from "./ticket-import-preview";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const STATUSES = ["TODO", "IN_PROGRESS", "DONE"];

function preview(
  content: string,
  options: { existing?: string[]; statuses?: readonly string[]; orgId?: string } = {},
) {
  return buildTicketImportPreview({
    orgId: options.orgId ?? ORG,
    projectId: 42,
    parsed: parseImportSource("csv", content),
    allowedStatuses: options.statuses ?? STATUSES,
    existingTitleKeys: options.existing ?? [],
  });
}

describe("buildTicketImportPreview valid rows", () => {
  it("accepts a minimal row and defaults the status to the project's first", () => {
    const result = preview("title\nShip it");
    expect(result.rows).toEqual([
      { rowNumber: 2, values: { title: "Ship it", status: "TODO" } },
    ]);
    expect(result.summary).toEqual({
      totalRows: 1,
      importable: 1,
      invalid: 0,
      duplicateInFile: 0,
      duplicateExisting: 0,
    });
  });

  it("coerces the string cells a CSV always produces", () => {
    const result = preview(
      "title,points,clientVisible,dueDate\nShip it,5,yes,2026-10-01",
    );
    expect(result.rows[0]?.values).toEqual({
      title: "Ship it",
      points: 5,
      clientVisible: true,
      dueDate: "2026-10-01",
      status: "TODO",
    });
  });

  it("matches a supplied status case-insensitively and stores the configured spelling", () => {
    expect(preview("title,status\nA,in_progress").rows[0]?.values.status).toBe("IN_PROGRESS");
  });

  it("treats an empty cell as an absent field rather than a null write", () => {
    const result = preview("title,description,points\nA,,");
    expect(result.rows[0]?.values).toEqual({ title: "A", status: "TODO" });
  });
});

describe("buildTicketImportPreview invalid rows", () => {
  it("names the row and the field for a missing title", () => {
    const result = preview("title,priority\n,HIGH");
    expect(result.rows).toEqual([]);
    expect(result.issues).toEqual([
      { rowNumber: 2, field: "title", kind: "INVALID", message: "Title is required" },
    ]);
  });

  it("names the row and the field for a bad enum", () => {
    const issue = preview("title,priority\nA,SOMEDAY").issues[0];
    expect(issue?.rowNumber).toBe(2);
    expect(issue?.field).toBe("priority");
    expect(issue?.kind).toBe("INVALID");
  });

  it("names the row and the field for a non-numeric number", () => {
    expect(preview("title,points\nA,soon").issues).toEqual([
      { rowNumber: 2, field: "points", kind: "INVALID", message: '"soon" is not a number' },
    ]);
  });

  it("names the row and the field for a non-boolean flag", () => {
    expect(preview("title,clientVisible\nA,maybe").issues[0]?.field).toBe("clientVisible");
  });

  it("rejects a calendar date that does not exist", () => {
    expect(preview("title,dueDate\nA,2026-02-31").issues[0]?.field).toBe("dueDate");
  });

  it("refuses a field that is not on the import allowlist", () => {
    const issue = preview("title,assigneeMembershipId\nA,9").issues[0];
    expect(issue).toEqual({
      rowNumber: 2,
      field: "assigneeMembershipId",
      kind: "INVALID",
      message: '"assigneeMembershipId" is not an importable field',
    });
  });

  it("refuses a status the project has not configured", () => {
    expect(preview("title,status\nA,ARCHIVED").issues).toEqual([
      {
        rowNumber: 2,
        field: "status",
        kind: "INVALID",
        message: '"ARCHIVED" is not a status configured on this project',
      },
    ]);
  });

  it("keeps the valid rows alongside the invalid ones", () => {
    const result = preview("title,points\nGood,3\n,4\nAlso good,5");
    expect(result.rows.map((row) => row.values.title)).toEqual(["Good", "Also good"]);
    expect(result.summary.invalid).toBe(1);
    expect(result.summary.importable).toBe(2);
  });

  it("carries a file level failure through without row issues", () => {
    const result = preview("{not csv at all");
    expect(result.fileError).toBeNull();
    expect(preview("   ").fileError).toBe("The file is empty");
  });

  it("refuses to preview against a project with no configured statuses", () => {
    const result = preview("title\nA", { statuses: [] });
    expect(result.fileError).toBe("The project has no configured statuses to import into");
    expect(result.confirmationToken).toBeNull();
  });
});

describe("buildTicketImportPreview duplicates", () => {
  it("keeps the first occurrence and flags the later one against its row", () => {
    const result = preview("title\nShip it\nShip it");
    expect(result.rows.map((row) => row.rowNumber)).toEqual([2]);
    expect(result.issues).toEqual([
      {
        rowNumber: 3,
        field: "title",
        kind: "DUPLICATE_IN_FILE",
        message: "Repeats the title on row 2",
      },
    ]);
    expect(result.summary.duplicateInFile).toBe(1);
  });

  it("normalises case and inner whitespace when matching", () => {
    expect(preview("title\nShip  it\nSHIP IT").summary.duplicateInFile).toBe(1);
  });

  it("flags a title that already exists in the project and never overwrites it", () => {
    const result = preview("title\nShip it", { existing: ["ship it"] });
    expect(result.rows).toEqual([]);
    expect(result.issues[0]?.kind).toBe("DUPLICATE_EXISTING");
    expect(result.summary.duplicateExisting).toBe(1);
  });
});

describe("confirmation token", () => {
  it("is null when nothing can be imported", () => {
    expect(preview("title\n,").confirmationToken).toBeNull();
  });

  it("is stable for the same rows in the same project", () => {
    expect(preview("title\nA").confirmationToken).toBe(preview("title\nA").confirmationToken);
  });

  it("changes when a value changes", () => {
    expect(preview("title\nA").confirmationToken).not.toBe(
      preview("title\nB").confirmationToken,
    );
  });

  it("changes when the tenant changes, so a token cannot cross organisations", () => {
    expect(preview("title\nA").confirmationToken).not.toBe(
      preview("title\nA", { orgId: OTHER_ORG }).confirmationToken,
    );
  });
});

describe("titleKey", () => {
  it("trims, lowercases and collapses whitespace", () => {
    expect(titleKey("  Ship   IT \n")).toBe("ship it");
  });
});
