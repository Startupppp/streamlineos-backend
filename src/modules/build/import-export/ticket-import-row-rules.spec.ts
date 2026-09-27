import { createTicketSchema } from "../core";
import { ticketImportRowSchema } from "./dto/ticket-import.schemas";

function importAccepts(row: Record<string, unknown>): boolean {
  return ticketImportRowSchema.safeParse(row).success;
}

function createAccepts(row: Record<string, unknown>): boolean {
  return createTicketSchema.safeParse(row).success;
}

function importIssueFields(row: Record<string, unknown>): string[] {
  const parsed = ticketImportRowSchema.safeParse(row);
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => String(issue.path[0] ?? ""));
}

describe("an imported row obeys the same title rule as a ticket created by hand", () => {
  it("rejects a title shorter than the three characters createTicketSchema demands", () => {
    expect(createAccepts({ title: "ab" })).toBe(false);
    expect(importAccepts({ title: "ab" })).toBe(false);
  });

  it("rejects a title with no letter or number, exactly as the create path does", () => {
    expect(createAccepts({ title: "!!!" })).toBe(false);
    expect(importAccepts({ title: "!!!" })).toBe(false);
  });

  it("accepts a title both paths allow, so the rule was tightened and not merely closed", () => {
    expect(createAccepts({ title: "Ship it" })).toBe(true);
    expect(importAccepts({ title: "Ship it" })).toBe(true);
  });

  it("blames the title field, so the row error names what to fix", () => {
    expect(importIssueFields({ title: "ab" })).toEqual(["title"]);
  });
});

describe("date ordering on an imported row is governed by the edit path, because the create path has no date fields", () => {
  it("is not judged against createTicketSchema, which rejects startDate and dueDate as unknown keys", () => {
    expect(createAccepts({ title: "Ship it" })).toBe(true);
    expect(createAccepts({ title: "Ship it", startDate: "2026-10-01" })).toBe(false);
    expect(createAccepts({ title: "Ship it", dueDate: "2026-10-01" })).toBe(false);
  });

  it("rejects a due date before the start date", () => {
    expect(
      importAccepts({ title: "Ship it", startDate: "2026-10-02", dueDate: "2026-10-01" }),
    ).toBe(false);
  });

  it("blames the due date, so the row error names the field the user must change", () => {
    expect(
      importIssueFields({ title: "Ship it", startDate: "2026-10-02", dueDate: "2026-10-01" }),
    ).toEqual(["dueDate"]);
  });

  it("accepts a due date on the start date, which is the boundary the rule allows", () => {
    expect(
      importAccepts({ title: "Ship it", startDate: "2026-10-01", dueDate: "2026-10-01" }),
    ).toBe(true);
  });

  it("accepts a due date after the start date (control)", () => {
    expect(
      importAccepts({ title: "Ship it", startDate: "2026-10-01", dueDate: "2026-10-05" }),
    ).toBe(true);
  });

  it("accepts a row carrying only one of the two dates", () => {
    expect(importAccepts({ title: "Ship it", dueDate: "2026-10-01" })).toBe(true);
    expect(importAccepts({ title: "Ship it", startDate: "2026-10-01" })).toBe(true);
  });
});

describe("the import still refuses fields the create path never accepted from a file", () => {
  it("rejects an unrecognised column rather than silently dropping it", () => {
    const parsed = ticketImportRowSchema.safeParse({
      title: "Ship it",
      assigneeMembershipId: 9,
    });
    expect(parsed.success).toBe(false);
  });

  it("still accepts the same row without that column (control)", () => {
    expect(importAccepts({ title: "Ship it" })).toBe(true);
  });
});
